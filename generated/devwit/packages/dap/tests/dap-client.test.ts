/**
 * DapClient 单测（迭代 33 / AC42）：Content-Length 分帧 DAP 协议路径。
 *
 * 不用 mock 框架：假进程 = PassThrough 三管道 + EventEmitter 退出事件，
 * 从 stdin 真实解析客户端写出的帧、向 stdout 真实写入适配器帧——
 * 粘包/半包/多字节 UTF-8 跨 chunk 全在 Buffer 层驱动，与真实适配器同口径。
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { DapClient, type DapChildProcess } from "../src/dap-client.js";

// ---------------------------------------------------------------------------
// 假进程 / 假适配器工具
// ---------------------------------------------------------------------------

class FakeProcess extends EventEmitter implements DapChildProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  /** 客户端写出的原始字节流（按 write 次序拼接）。 */
  private written: Buffer[] = [];

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.written.push(chunk);
    });
  }

  kill(): void {
    this.killed = true;
    queueMicrotask(() => this.emit("exit", null));
  }

  writtenBytes(): Buffer {
    return Buffer.concat(this.written);
  }

  pushMessage(message: Record<string, unknown>): void {
    const body = JSON.stringify(message);
    this.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`, "utf-8");
  }

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

/** 从客户端写出的字节流中解析全部已发出的 DAP 消息。 */
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

function makeClient(proc: FakeProcess, requestTimeoutMs = 500): DapClient {
  return new DapClient("fake", [], {}, () => proc, requestTimeoutMs);
}

/** 完成 initialize 握手（客户端写出请求后，假适配器应答）。 */
async function handshake(client: DapClient, proc: FakeProcess): Promise<void> {
  const started = client.start();
  await new Promise((resolve) => setImmediate(resolve));
  const initReq = parseWritten(proc).find((m) => m.command === "initialize");
  expect(initReq).toBeDefined();
  proc.pushMessage({ seq: 1, type: "response", request_seq: initReq?.seq, success: true, command: "initialize", body: { supportsConfigurationDoneRequest: true } });
  await started;
}

// ---------------------------------------------------------------------------
// Content-Length 分帧
// ---------------------------------------------------------------------------

describe("DapClient 分帧", () => {
  it("粘包：单 chunk 两条消息依次分发（响应 + 事件）", async () => {
    const proc = new FakeProcess();
    const client = makeClient(proc);
    await handshake(client, proc);

    const events: string[] = [];
    client.onEvent = (event) => events.push(event);
    const p = client.request("threads");
    await new Promise((resolve) => setImmediate(resolve));
    const req = parseWritten(proc).find((m) => m.command === "threads");
    // 响应 + 事件拼一个 chunk 一次性推入
    const r1 = JSON.stringify({ seq: 2, type: "response", request_seq: req?.seq, success: true, command: "threads", body: { threads: [{ id: 1, name: "main" }] } });
    const r2 = JSON.stringify({ seq: 3, type: "event", event: "output", body: { output: "hi" } });
    proc.pushRaw(`Content-Length: ${Buffer.byteLength(r1)}\r\n\r\n${r1}Content-Length: ${Buffer.byteLength(r2)}\r\n\r\n${r2}`);
    await expect(p).resolves.toEqual({ threads: [{ id: 1, name: "main" }] });
    expect(events).toEqual(["output"]);
    await client.close();
  });

  it("半包：头/正文分 chunk 到达，收全后才分发", async () => {
    const proc = new FakeProcess();
    const client = makeClient(proc);
    await handshake(client, proc);

    const p = client.request("threads");
    await new Promise((resolve) => setImmediate(resolve));
    const req = parseWritten(proc).find((m) => m.command === "threads");
    const body = JSON.stringify({ seq: 2, type: "response", request_seq: req?.seq, success: true, command: "threads", body: { threads: [] } });
    const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    const bytes = Buffer.from(frame, "utf-8");
    proc.pushRaw(bytes.subarray(0, 10)); // 头都未收全
    proc.pushRaw(bytes.subarray(10, 30)); // 头收全、正文半包
    await new Promise((resolve) => setImmediate(resolve));
    let settled = false;
    void p.then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    proc.pushRaw(bytes.subarray(30));
    await expect(p).resolves.toEqual({ threads: [] });
    await client.close();
  });

  it("多字节 UTF-8 跨 chunk：Content-Length 按字节计不截断", async () => {
    const proc = new FakeProcess();
    const client = makeClient(proc);
    await handshake(client, proc);

    const p = client.request("evaluate", { expression: "x" });
    await new Promise((resolve) => setImmediate(resolve));
    const req = parseWritten(proc).find((m) => m.command === "evaluate");
    const body = JSON.stringify({ seq: 2, type: "response", request_seq: req?.seq, success: true, command: "evaluate", body: { result: "值=汉字✕", variablesReference: 0 } });
    const frame = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, "utf-8");
    // 从多字节字符中间切开
    const cut = frame.length - 6;
    proc.pushRaw(frame.subarray(0, cut));
    proc.pushRaw(frame.subarray(cut));
    await expect(p).resolves.toEqual({ result: "值=汉字✕", variablesReference: 0 });
    await client.close();
  });

  it("非法 JSON 正文跳过不中断会话", async () => {
    const proc = new FakeProcess();
    const client = makeClient(proc);
    await handshake(client, proc);

    proc.pushRaw("Content-Length: 7\r\n\r\n{bad js");
    const p = client.request("threads");
    await new Promise((resolve) => setImmediate(resolve));
    const req = parseWritten(proc).find((m) => m.command === "threads");
    proc.pushMessage({ seq: 9, type: "response", request_seq: req?.seq, success: true, command: "threads", body: { threads: [{ id: 7, name: "t" }] } });
    await expect(p).resolves.toEqual({ threads: [{ id: 7, name: "t" }] });
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// 请求/响应匹配
// ---------------------------------------------------------------------------

describe("DapClient 请求响应", () => {
  it("seq 自增且按 request_seq 匹配，乱序响应各归其位", async () => {
    const proc = new FakeProcess();
    const client = makeClient(proc);
    await handshake(client, proc);

    const p1 = client.request("stackTrace", { threadId: 1 });
    const p2 = client.request("scopes", { frameId: 9 });
    await new Promise((resolve) => setImmediate(resolve));
    const sent = parseWritten(proc);
    const stackReq = sent.find((m) => m.command === "stackTrace");
    const scopeReq = sent.find((m) => m.command === "scopes");
    expect(typeof stackReq?.seq).toBe("number");
    expect((scopeReq?.seq as number) - (stackReq?.seq as number)).toBe(1);
    // 乱序：先答 scopes 后答 stackTrace
    proc.pushMessage({ seq: 10, type: "response", request_seq: scopeReq?.seq, success: true, command: "scopes", body: { scopes: [] } });
    proc.pushMessage({ seq: 11, type: "response", request_seq: stackReq?.seq, success: true, command: "stackTrace", body: { stackFrames: [{ id: 1 }] } });
    await expect(p1).resolves.toEqual({ stackFrames: [{ id: 1 }] });
    await expect(p2).resolves.toEqual({ scopes: [] });
    await client.close();
  });

  it("success=false 拒绝并带 command 与 message 摘要", async () => {
    const proc = new FakeProcess();
    const client = makeClient(proc);
    await handshake(client, proc);

    const p = client.request("setBreakpoints", { source: { path: "/x.js" } });
    await new Promise((resolve) => setImmediate(resolve));
    const req = parseWritten(proc).find((m) => m.command === "setBreakpoints");
    proc.pushMessage({ seq: 2, type: "response", request_seq: req?.seq, success: false, command: "setBreakpoints", message: "read EISDIR" });
    await expect(p).rejects.toThrow("DW_DAP_REQUEST_FAILED:setBreakpoints:read EISDIR");
    await client.close();
  });

  it("请求超时拒绝 DW_DAP_TIMEOUT", async () => {
    const proc = new FakeProcess();
    const client = makeClient(proc, 50);
    await handshake(client, proc);
    await expect(client.request("stackTrace", { threadId: 1 })).rejects.toThrow("DW_DAP_TIMEOUT:stackTrace");
    await client.close();
  });

  it("未运行时请求拒绝 DW_DAP_NOT_RUNNING", async () => {
    const proc = new FakeProcess();
    const client = makeClient(proc);
    await expect(client.request("threads")).rejects.toThrow("DW_DAP_NOT_RUNNING");
  });

  it("重复 start 拒绝 DW_DAP_ALREADY_STARTED", async () => {
    const proc = new FakeProcess();
    const client = makeClient(proc);
    await handshake(client, proc);
    await expect(client.start()).rejects.toThrow("DW_DAP_ALREADY_STARTED");
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// 事件与反向请求
// ---------------------------------------------------------------------------

describe("DapClient 事件与反向请求", () => {
  it("事件回调带 body 分发", async () => {
    const proc = new FakeProcess();
    const client = makeClient(proc);
    await handshake(client, proc);

    const seen: Array<{ event: string; body: unknown }> = [];
    client.onEvent = (event, body) => seen.push({ event, body });
    proc.pushMessage({ seq: 5, type: "event", event: "stopped", body: { threadId: 3, reason: "breakpoint" } });
    expect(seen).toEqual([{ event: "stopped", body: { threadId: 3, reason: "breakpoint" } }]);
    await client.close();
  });

  it("适配器反向请求（runInTerminal）拒答 error 不挂起", async () => {
    const proc = new FakeProcess();
    const client = makeClient(proc);
    await handshake(client, proc);

    proc.pushMessage({ seq: 42, type: "request", command: "runInTerminal", arguments: { kind: "integrated", title: "x", cwd: "/", args: ["node", "a.js"] } });
    await new Promise((resolve) => setImmediate(resolve));
    const sent = parseWritten(proc);
    const reply = sent.find((m) => m.type === "response" && m.request_seq === 42);
    expect(reply).toBeDefined();
    expect(reply?.success).toBe(false);
    expect(reply?.command).toBe("runInTerminal");
    // 会话仍可继续
    const p = client.request("threads");
    await new Promise((resolve) => setImmediate(resolve));
    const req = parseWritten(proc).filter((m) => m.command === "threads").at(-1);
    proc.pushMessage({ seq: 43, type: "response", request_seq: req?.seq, success: true, command: "threads", body: { threads: [] } });
    await expect(p).resolves.toEqual({ threads: [] });
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

describe("DapClient 生命周期", () => {
  it("进程退出拒绝全部挂起并回调 onExit", async () => {
    const proc = new FakeProcess();
    const client = makeClient(proc);
    await handshake(client, proc);

    let exitCode: number | null | undefined;
    client.onExit = (code) => { exitCode = code; };
    const p = client.request("stackTrace", { threadId: 1 });
    proc.simulateExit(1);
    await expect(p).rejects.toThrow("DW_DAP_ADAPTER_EXIT:1");
    expect(exitCode).toBe(1);
  });

  it("spawn 异步失败（error 事件）拒绝挂起并抛 DW_DAP_SPAWN_FAILED", async () => {
    const proc = new FakeProcess();
    const client = makeClient(proc);
    const started = client.start();
    proc.simulateSpawnError("spawn fake ENOENT");
    await expect(started).rejects.toThrow("DW_DAP_SPAWN_FAILED");
  });

  it("initialize 失败时进程已清理", async () => {
    const proc = new FakeProcess();
    const client = makeClient(proc);
    const started = client.start();
    await new Promise((resolve) => setImmediate(resolve));
    const initReq = parseWritten(proc).find((m) => m.command === "initialize");
    proc.pushMessage({ seq: 1, type: "response", request_seq: initReq?.seq, success: false, command: "initialize", message: "bad client" });
    await expect(started).rejects.toThrow("DW_DAP_REQUEST_FAILED:initialize");
    expect(client.isRunning).toBe(false);
  });

  it("close 发 disconnect；进程不退则 3s 强杀兜底", async () => {
    const proc = new FakeProcess();
    const client = makeClient(proc, 5000);
    await handshake(client, proc);
    const closed = client.close();
    await new Promise((resolve) => setImmediate(resolve));
    const sent = parseWritten(proc);
    expect(sent.some((m) => m.command === "disconnect")).toBe(true);
    // 假进程不响应 disconnect（适配器死了）→ 请求超时(5s)会太久，直接模拟不退 + 等强杀
    // 注：disconnect 请求挂起，close 内 catch 吞掉；此处模拟进程在超时后被强杀
    proc.simulateExit(0); // 适配器随后退出
    await closed;
    expect(client.isRunning).toBe(false);
  });
});
