/**
 * LspClient 单测（迭代 31 / AC40）：Content-Length 分帧 JSON-RPC 2.0 协议路径。
 *
 * 不用 mock 框架：假进程 = PassThrough 三管道 + EventEmitter 退出事件，
 * 从 stdin 真实解析客户端写出的帧、向 stdout 真实写入服务器帧——
 * 粘包/半包/多字节 UTF-8 跨 chunk 全在 Buffer 层驱动，与真实服务器同口径。
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { LspClient, type LspChildProcess } from "../src/lsp-client.js";

// ---------------------------------------------------------------------------
// 假进程 / 假服务器工具
// ---------------------------------------------------------------------------

class FakeProcess extends EventEmitter implements LspChildProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  /** 收到 exit 通知时是否自动退出（真实服务器语义；强杀兜底测试置 false）。 */
  autoExitOnExitNotification = true;
  /** 客户端写出的原始字节流（按 write 次序拼接）。 */
  private written: Buffer[] = [];

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.written.push(chunk);
      // 真实服务器语义：收到 exit 通知即退出（帧为单次 write 的 header+body，
      // JSON.stringify 无空格，字符串匹配可靠）
      if (this.autoExitOnExitNotification && chunk.toString("utf-8").includes('"method":"exit"')) {
        queueMicrotask(() => this.emit("exit", 0));
      }
    });
  }

  kill(): void {
    this.killed = true;
    queueMicrotask(() => this.emit("exit", null));
  }

  /** 客户端已写出的全部字节。 */
  writtenBytes(): Buffer {
    return Buffer.concat(this.written);
  }

  /** 向客户端推送一条服务器消息（自动 Content-Length 分帧）。 */
  pushMessage(message: Record<string, unknown>): void {
    const body = JSON.stringify(message);
    this.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`, "utf-8");
  }

  /** 向客户端推送原始字节（分 chunk 驱动半包/粘包场景）。 */
  pushRaw(chunk: Buffer | string): void {
    this.stdout.write(chunk);
  }

  simulateExit(code: number | null): void {
    this.emit("exit", code);
  }

  simulateSpawnError(message: string): void {
    this.emit("error", new Error(message));
  }
}

/** 从客户端写出的字节流中解析全部已发出的 JSON-RPC 消息。 */
function parseWritten(proc: FakeProcess): Array<Record<string, unknown>> {
  const buf = proc.writtenBytes();
  const messages: Array<Record<string, unknown>> = [];
  let offset = 0;
  for (;;) {
    const headerEnd = buf.indexOf("\r\n\r\n", offset);
    if (headerEnd < 0) break;
    const header = buf.subarray(offset, headerEnd).toString("ascii");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (match === null) break;
    const length = Number.parseInt(match[1] ?? "0", 10);
    const bodyStart = headerEnd + 4;
    if (buf.length < bodyStart + length) break;
    messages.push(JSON.parse(buf.subarray(bodyStart, bodyStart + length).toString("utf-8")) as Record<string, unknown>);
    offset = bodyStart + length;
  }
  return messages;
}

function makeClient(proc: FakeProcess, requestTimeoutMs = 500): LspClient {
  return new LspClient("fake", [], {}, () => proc, requestTimeoutMs);
}

/** 完成 initialize 握手（客户端写出请求后，假服务器应答）。 */
async function handshake(client: LspClient, proc: FakeProcess): Promise<void> {
  const started = client.start("file:///root");
  // 等客户端把 initialize 写出来
  await new Promise((resolve) => setImmediate(resolve));
  const initReq = parseWritten(proc).find((m) => m.method === "initialize");
  expect(initReq).toBeDefined();
  proc.pushMessage({ jsonrpc: "2.0", id: initReq?.id, result: { capabilities: {} } });
  await started;
}

// ---------------------------------------------------------------------------
// Content-Length 分帧
// ---------------------------------------------------------------------------

describe("LspClient 分帧", () => {
  it("粘包：单 chunk 两条消息依次分发", async () => {
    const proc = new FakeProcess();
    const client = makeClient(proc);
    await handshake(client, proc);

    const results: unknown[] = [];
    const notifications: string[] = [];
    client.onNotification = (method) => notifications.push(method);
    const p1 = client.request("textDocument/hover", {}).then((r) => results.push(r));
    const sent = parseWritten(proc);
    const hoverReq = sent.find((m) => m.method === "textDocument/hover");
    // 两条消息拼成一个 chunk 一次性推入
    const body1 = JSON.stringify({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: "file:///a", diagnostics: [] } });
    const body2 = JSON.stringify({ jsonrpc: "2.0", id: hoverReq?.id, result: { contents: "x" } });
    proc.pushRaw(
      `Content-Length: ${Buffer.byteLength(body1)}\r\n\r\n${body1}Content-Length: ${Buffer.byteLength(body2)}\r\n\r\n${body2}`
    );
    await p1;
    expect(notifications).toEqual(["textDocument/publishDiagnostics"]);
    expect(results).toEqual([{ contents: "x" }]);
    await client.close();
  });

  it("半包：头部分跨 chunk、正文分跨 chunk 均正确重组", async () => {
    const proc = new FakeProcess();
    const client = makeClient(proc);
    await handshake(client, proc);

    const done = client.request("textDocument/hover", {});
    await new Promise((resolve) => setImmediate(resolve));
    const hoverReq = parseWritten(proc).find((m) => m.method === "textDocument/hover");
    const body = JSON.stringify({ jsonrpc: "2.0", id: hoverReq?.id, result: { contents: "ok" } });
    const frame = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, "utf-8");
    // 头部分两段：第一截停在 "Content-Len"
    proc.pushRaw(frame.subarray(0, 11));
    await new Promise((resolve) => setImmediate(resolve));
    proc.pushRaw(frame.subarray(11, 30)); // 头部剩余 + \r\n\r\n + 正文一部分
    await new Promise((resolve) => setImmediate(resolve));
    proc.pushRaw(frame.subarray(30));
    await expect(done).resolves.toEqual({ contents: "ok" });
    await client.close();
  });

  it("多字节 UTF-8 跨 chunk 截断不损坏载荷（字节定长而非字符定长）", async () => {
    const proc = new FakeProcess();
    const client = makeClient(proc);
    await handshake(client, proc);

    const done = client.request("textDocument/hover", {});
    await new Promise((resolve) => setImmediate(resolve));
    const hoverReq = parseWritten(proc).find((m) => m.method === "textDocument/hover");
    // 载荷含中文（3 字节/字符），服务器应答的 Content-Length 必须是字节数
    const body = JSON.stringify({ jsonrpc: "2.0", id: hoverReq?.id, result: { contents: "函数签名" } });
    const frame = Buffer.from(`Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`, "utf-8");
    // 把一个中文字符的 3 个字节切成 1+2 两截
    const cutAt = frame.indexOf(Buffer.from("函", "utf-8").subarray(0, 1));
    expect(cutAt).toBeGreaterThan(0);
    proc.pushRaw(frame.subarray(0, cutAt + 1));
    await new Promise((resolve) => setImmediate(resolve));
    proc.pushRaw(frame.subarray(cutAt + 1));
    await expect(done).resolves.toEqual({ contents: "函数签名" });
    await client.close();
  });

  it("非法 JSON 正文跳过不中断会话，后续消息正常分发", async () => {
    const proc = new FakeProcess();
    const client = makeClient(proc);
    await handshake(client, proc);

    const notifications: string[] = [];
    client.onNotification = (method) => notifications.push(method);
    const bad = Buffer.from("not-json{{{", "utf-8");
    proc.pushRaw(`Content-Length: ${bad.length}\r\n\r\n`);
    proc.pushRaw(bad);
    proc.pushMessage({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: "file:///b", diagnostics: [] } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(notifications).toEqual(["textDocument/publishDiagnostics"]);
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

describe("LspClient 生命周期", () => {
  it("握手：initialize 请求形状 + initialized 通知 + isInitialized", async () => {
    const proc = new FakeProcess();
    const client = makeClient(proc);
    await handshake(client, proc);
    expect(client.isInitialized).toBe(true);
    const sent = parseWritten(proc);
    const init = sent.find((m) => m.method === "initialize") as { params: { rootUri: string } } | undefined;
    expect(init?.params.rootUri).toBe("file:///root");
    expect(sent.some((m) => m.method === "initialized" && m.id === undefined)).toBe(true);
    await client.close();
  });

  it("重复 start 拒绝 DW_LSP_ALREADY_STARTED", async () => {
    const proc = new FakeProcess();
    const client = makeClient(proc);
    await handshake(client, proc);
    await expect(client.start("file:///x")).rejects.toThrow("DW_LSP_ALREADY_STARTED");
    await client.close();
  });

  it("未启动时 request 拒绝 DW_LSP_NOT_RUNNING；notify 静默丢弃", async () => {
    const proc = new FakeProcess();
    const client = makeClient(proc);
    await expect(client.request("textDocument/hover")).rejects.toThrow("DW_LSP_NOT_RUNNING");
    client.notify("textDocument/didOpen", {}); // 不抛
    expect(proc.writtenBytes().length).toBe(0);
  });

  it("请求超时拒绝 DW_LSP_TIMEOUT:<method>", async () => {
    const proc = new FakeProcess();
    const client = makeClient(proc, 50);
    await handshake(client, proc);
    await expect(client.request("textDocument/hover", {})).rejects.toThrow("DW_LSP_TIMEOUT:textDocument/hover");
    await client.close();
  });

  it("进程退出拒绝全部挂起请求（DW_LSP_SERVER_EXIT），onExit 回调收到退出码", async () => {
    const proc = new FakeProcess();
    const client = makeClient(proc, 5_000);
    await handshake(client, proc);
    const exitCodes: Array<number | null> = [];
    client.onExit = (code) => exitCodes.push(code);
    const pending = client.request("textDocument/hover", {});
    const assertion = expect(pending).rejects.toThrow("DW_LSP_SERVER_EXIT:1");
    proc.simulateExit(1);
    await assertion;
    expect(exitCodes).toEqual([1]);
    expect(client.isRunning).toBe(false);
  });

  it("spawn 异步失败（error 事件）走退出路径，挂起请求被拒绝", async () => {
    const proc = new FakeProcess();
    const client = makeClient(proc, 5_000);
    await handshake(client, proc);
    const pending = client.request("textDocument/hover", {});
    const assertion = expect(pending).rejects.toThrow("DW_LSP_SPAWN_FAILED:ENOENT fake");
    proc.simulateSpawnError("ENOENT fake");
    await assertion;
  });

  it("握手失败（initialize 报错）进程已清理，拒绝原因含 RPC 错误码", async () => {
    const proc = new FakeProcess();
    const client = makeClient(proc);
    const started = client.start("file:///root");
    await new Promise((resolve) => setImmediate(resolve));
    const initReq = parseWritten(proc).find((m) => m.method === "initialize");
    proc.pushMessage({ jsonrpc: "2.0", id: initReq?.id, error: { code: -32602, message: "bad params" } });
    await expect(started).rejects.toThrow("DW_LSP_RPC_-32602");
    expect(client.isRunning).toBe(false);
    expect(client.isInitialized).toBe(false);
  });

  it("close：shutdown 请求 → exit 通知 → 进程退出；幂等", async () => {
    const proc = new FakeProcess();
    const client = makeClient(proc);
    await handshake(client, proc);
    const closed = client.close();
    await new Promise((resolve) => setImmediate(resolve));
    const shutdownReq = parseWritten(proc).find((m) => m.method === "shutdown");
    expect(shutdownReq).toBeDefined();
    proc.pushMessage({ jsonrpc: "2.0", id: shutdownReq?.id, result: null });
    await new Promise((resolve) => setImmediate(resolve));
    proc.simulateExit(0);
    await closed;
    const sent = parseWritten(proc);
    expect(sent.some((m) => m.method === "exit" && m.id === undefined)).toBe(true);
    expect(client.isRunning).toBe(false);
    await client.close(); // 幂等不抛
  });

  it("close 时进程不退出则 3s 后强杀兜底", async () => {
    const proc = new FakeProcess();
    proc.autoExitOnExitNotification = false; // 服务器僵死：不应答后的 exit 通知也不退出
    const client = makeClient(proc);
    await handshake(client, proc);
    const closed = client.close();
    // 立即响应 shutdown 以进入等待退出阶段
    await new Promise((resolve) => setImmediate(resolve));
    const shutdownReq = parseWritten(proc).find((m) => m.method === "shutdown");
    proc.pushMessage({ jsonrpc: "2.0", id: shutdownReq?.id, result: null });
    // 不 simulateExit —— 等 3s race 超时（测试环境下接受该耗时上限，vitest timeout 30s）
    await closed;
    expect(proc.killed).toBe(true);
    expect(client.isRunning).toBe(false);
  }, 10_000);
});
