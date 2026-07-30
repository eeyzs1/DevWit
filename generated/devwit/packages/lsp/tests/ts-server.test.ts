/**
 * TsLanguageServer 单测（迭代 31 / AC40）：
 * A. 纯函数——URI 编解码往返 / languageIdFor / normalizeHoverText；
 * B. 假 spawn 驱动——状态机 / 文档同步帧形状 / 诊断聚合 / shutdown 序列；
 * C. 真实 typescript-language-server 集成——temp fixture 上 hover/definition/
 *    diagnostics 真实应答（零 mock，与 e2e 同口径的服务器二进制）。
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { LspStatusInfo } from "@devwit/contracts";
import type { LspChildProcess } from "../src/lsp-client.js";
import {
  TsLanguageServer,
  absolutePathToUri,
  languageIdFor,
  normalizeHoverText,
  uriToAbsolutePath,
} from "../src/ts-server.js";

// ---------------------------------------------------------------------------
// A. 纯函数
// ---------------------------------------------------------------------------

describe("URI 编解码", () => {
  it("Windows 盘符路径 → file URI（冒号百分号编码）并往返还原", () => {
    const abs = path.resolve("E:/work/proj/src/main.ts");
    const uri = absolutePathToUri(abs);
    expect(uri.startsWith("file:///")).toBe(true);
    expect(uri).toContain(encodeURIComponent("main.ts"));
    expect(uriToAbsolutePath(uri).replace(/\\/g, "/")).toBe(abs.replace(/\\/g, "/"));
  });

  it("含空格与中文的段名百分号编码后仍可往返", () => {
    const abs = path.resolve("E:/工作 目录/子 文件.ts");
    const uri = absolutePathToUri(abs);
    expect(uri).not.toContain(" ");
    expect(uriToAbsolutePath(uri).replace(/\\/g, "/")).toBe(abs.replace(/\\/g, "/"));
  });

  it("非 file:// URI 原样返回", () => {
    expect(uriToAbsolutePath("untitled:Untitled-1")).toBe("untitled:Untitled-1");
  });
});

describe("languageIdFor", () => {
  it("ts/tsx/js/jsx/mts/cts/mjs/cjs 映射正确", () => {
    expect(languageIdFor("a.ts")).toBe("typescript");
    expect(languageIdFor("a.mts")).toBe("typescript");
    expect(languageIdFor("a.cts")).toBe("typescript");
    expect(languageIdFor("a.tsx")).toBe("typescriptreact");
    expect(languageIdFor("a.js")).toBe("javascript");
    expect(languageIdFor("a.mjs")).toBe("javascript");
    expect(languageIdFor("a.cjs")).toBe("javascript");
    expect(languageIdFor("a.jsx")).toBe("javascriptreact");
  });

  it("非 TS/JS 扩展返回 null", () => {
    expect(languageIdFor("a.md")).toBeNull();
    expect(languageIdFor("a.json")).toBeNull();
    expect(languageIdFor("README")).toBeNull();
  });
});

describe("normalizeHoverText", () => {
  it("null/undefined/空串 → null", () => {
    expect(normalizeHoverText(null)).toBeNull();
    expect(normalizeHoverText(undefined)).toBeNull();
    expect(normalizeHoverText({ contents: "" })).toBeNull();
    expect(normalizeHoverText({})).toBeNull();
  });

  it("字符串 / MarkupContent / MarkedString 数组三形态归一", () => {
    expect(normalizeHoverText({ contents: "sig" })).toBe("sig");
    expect(normalizeHoverText({ contents: { kind: "markdown", value: "**sig**" } })).toBe("**sig**");
    expect(
      normalizeHoverText({ contents: [{ language: "typescript", value: "const x: 1" }, "说明"] })
    ).toBe("const x: 1\n\n说明");
  });

  it("数组中空白项被滤除，全空白 → null", () => {
    expect(normalizeHoverText({ contents: ["  ", ""] })).toBeNull();
    expect(normalizeHoverText({ contents: ["", "real"] })).toBe("real");
  });
});

// ---------------------------------------------------------------------------
// B. 假 spawn 驱动的 TsLanguageServer
// ---------------------------------------------------------------------------

/** 脚本化假 LSP 服务器：应答 initialize/shutdown，记录全部通知，可推诊断。 */
class FakeServerProcess extends EventEmitter implements LspChildProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  private inBuffer = Buffer.alloc(0);
  /** 客户端发来的全部消息（按到达次序）。 */
  readonly received: Array<Record<string, unknown>> = [];

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => this.consume(chunk));
  }

  kill(): void {
    this.killed = true;
    queueMicrotask(() => this.emit("exit", null));
  }

  respond(requestId: number, result: unknown): void {
    const body = JSON.stringify({ jsonrpc: "2.0", id: requestId, result });
    this.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, "utf-8");
  }

  pushDiagnostics(uri: string, diagnostics: unknown[]): void {
    const body = JSON.stringify({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics } });
    this.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, "utf-8");
  }

  notificationsOf(method: string): Array<Record<string, unknown>> {
    return this.received.filter((m) => m.method === method);
  }

  simulateExit(code: number | null): void {
    this.emit("exit", code);
  }

  private consume(chunk: Buffer): void {
    this.inBuffer = this.inBuffer.length === 0 ? chunk : Buffer.concat([this.inBuffer, chunk]);
    for (;;) {
      const headerEnd = this.inBuffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const match = /Content-Length:\s*(\d+)/i.exec(this.inBuffer.subarray(0, headerEnd).toString("ascii"));
      if (match === null) return;
      const length = Number.parseInt(match[1] ?? "0", 10);
      const bodyStart = headerEnd + 4;
      if (this.inBuffer.length < bodyStart + length) return;
      const message = JSON.parse(this.inBuffer.subarray(bodyStart, bodyStart + length).toString("utf-8")) as Record<string, unknown>;
      this.inBuffer = this.inBuffer.subarray(bodyStart + length);
      this.received.push(message);
      if (message.method === "initialize" && typeof message.id === "number") {
        this.respond(message.id, { capabilities: {} });
      } else if (message.method === "shutdown" && typeof message.id === "number") {
        this.respond(message.id, null);
      } else if (message.method === "exit") {
        // 真实服务器语义：收到 exit 通知即退出
        queueMicrotask(() => this.emit("exit", 0));
      }
    }
  }
}

function makeFakeServer(rootPath: string) {
  const proc = new FakeServerProcess();
  const server = new TsLanguageServer({
    cliPath: "fake-cli.mjs",
    nodeCommand: "fake-node",
    spawnImpl: () => proc,
  });
  return { proc, server, rootPath };
}

describe("TsLanguageServer（假 spawn）", () => {
  it("openWorkspace：状态机 starting→ready，initialize 的 rootUri 指向工作区", async () => {
    const root = path.resolve("E:/ws/demo");
    const { proc, server } = makeFakeServer(root);
    const states: string[] = [];
    server.onStatus = (s: LspStatusInfo) => states.push(s.state);
    await server.openWorkspace(root);
    expect(states).toEqual(["starting", "ready"]);
    const init = proc.received.find((m) => m.method === "initialize") as { params: { rootUri: string } };
    expect(init.params.rootUri).toBe(absolutePathToUri(root));
    await server.shutdown();
  });

  it("同 root 重复 openWorkspace 幂等复用（不二次 initialize）", async () => {
    const root = path.resolve("E:/ws/demo");
    const { proc, server } = makeFakeServer(root);
    await server.openWorkspace(root);
    await server.openWorkspace(root);
    expect(proc.notificationsOf("noop")).toEqual([]);
    expect(proc.received.filter((m) => m.method === "initialize").length).toBe(1);
    await server.shutdown();
  });

  it("didOpen/didChange/didClose 帧形状：uri/languageId/version/Full text", async () => {
    const root = path.resolve("E:/ws/demo");
    const { proc, server } = makeFakeServer(root);
    await server.openWorkspace(root);
    server.didOpen("src/a.ts", "const x: number = 1;");
    const opened = proc.notificationsOf("textDocument/didOpen")[0] as {
      params: { textDocument: { uri: string; languageId: string; version: number; text: string } };
    };
    expect(opened.params.textDocument.languageId).toBe("typescript");
    expect(opened.params.textDocument.version).toBe(1);
    expect(opened.params.textDocument.text).toBe("const x: number = 1;");
    expect(opened.params.textDocument.uri).toBe(absolutePathToUri(path.join(root, "src/a.ts")));

    server.didChange("src/a.ts", "const x: number = 2;");
    const changed = proc.notificationsOf("textDocument/didChange")[0] as {
      params: { textDocument: { version: number }; contentChanges: Array<{ text: string }> };
    };
    expect(changed.params.textDocument.version).toBe(2);
    expect(changed.params.contentChanges).toEqual([{ text: "const x: number = 2;" }]);

    server.didClose("src/a.ts");
    expect(proc.notificationsOf("textDocument/didClose").length).toBe(1);
    await server.shutdown();
  });

  it("非 TS/JS 文件不同步（markdown 打开无帧）", async () => {
    const root = path.resolve("E:/ws/demo");
    const { proc, server } = makeFakeServer(root);
    await server.openWorkspace(root);
    server.didOpen("README.md", "# hi");
    expect(proc.notificationsOf("textDocument/didOpen").length).toBe(0);
    await server.shutdown();
  });

  it("诊断聚合：publishDiagnostics → listDiagnostics（相对路径 + severity 映射），didClose 清除", async () => {
    const root = path.resolve("E:/ws/demo");
    const { proc, server } = makeFakeServer(root);
    await server.openWorkspace(root);
    server.didOpen("src/a.ts", "const x: number = 's';");
    const uri = absolutePathToUri(path.join(root, "src/a.ts"));
    let snapshots = 0;
    server.onDiagnostics = () => {
      snapshots += 1;
    };
    proc.pushDiagnostics(uri, [
      { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 25 } }, severity: 1, code: 2322, message: "Type 'string' is not assignable" },
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 2, message: "unused" },
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(snapshots).toBe(1);
    const items = server.listDiagnostics();
    expect(items.length).toBe(2);
    expect(items[0]?.file).toBe("src/a.ts");
    expect(items[0]?.severity).toBe("error");
    expect(items[0]?.code).toBe("2322");
    expect(items[1]?.severity).toBe("warning");

    server.didClose("src/a.ts");
    expect(server.listDiagnostics().length).toBe(0);
    expect(snapshots).toBe(2); // didClose 清除也触发一次快照
    await server.shutdown();
  });

  it("非主动退出 → error 态（DW_LSP_SERVER_EXIT），诊断清空", async () => {
    const root = path.resolve("E:/ws/demo");
    const { proc, server } = makeFakeServer(root);
    await server.openWorkspace(root);
    const states: LspStatusInfo[] = [];
    server.onStatus = (s) => states.push(s);
    proc.simulateExit(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(server.currentStatus).toEqual({ state: "error", code: "DW_LSP_SERVER_EXIT" });
    expect(server.listDiagnostics()).toEqual([]);
  });

  it("shutdown：先置 idle 防误报，shutdown/exit 序列发出，幂等", async () => {
    const root = path.resolve("E:/ws/demo");
    const { proc, server } = makeFakeServer(root);
    await server.openWorkspace(root);
    const states: string[] = [];
    server.onStatus = (s: LspStatusInfo) => states.push(s.state);
    const closing = server.shutdown();
    await new Promise((resolve) => setImmediate(resolve));
    proc.simulateExit(0);
    await closing;
    expect(states).toEqual(["idle"]);
    expect(proc.received.some((m) => m.method === "shutdown")).toBe(true);
    expect(proc.received.some((m) => m.method === "exit")).toBe(true);
    expect(server.currentStatus.state).toBe("idle");
    await server.shutdown(); // 幂等
  });

  it("未 ready 时 hover/definition/completion 返回空，不发出请求", async () => {
    const root = path.resolve("E:/ws/demo");
    const { proc, server } = makeFakeServer(root);
    expect(await server.hover("a.ts", 0, 0)).toBeNull();
    expect(await server.definition("a.ts", 0, 0)).toEqual([]);
    expect(await server.completion("a.ts", 0, 0)).toEqual([]);
    await server.openWorkspace(root);
    // ready 但假服务器不应答 hover（请求超时由客户端层保障，这里只验证形状）
    await server.shutdown();
    expect(proc.received.filter((m) => m.method === "textDocument/hover").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// C. 真实 typescript-language-server 集成（temp fixture，零 mock）
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
const CLI = require.resolve("typescript-language-server/lib/cli.mjs") as string;

describe("TsLanguageServer（真实 typescript-language-server 集成）", () => {
  let fixture = "";

  afterEach(() => {
    if (fixture !== "") rmSync(fixture, { recursive: true, force: true });
    fixture = "";
  });

  it("temp fixture 上 hover/definition/diagnostics 真实应答", async () => {
    fixture = mkdtempSync(path.join(os.tmpdir(), "devwit-ac40-lsp-"));
    writeFileSync(
      path.join(fixture, "math.ts"),
      ["export function add(a: number, b: number): number {", "  return a + b;", "}", ""].join("\n"),
      "utf-8"
    );
    writeFileSync(
      path.join(fixture, "main.ts"),
      ["import { add } from './math';", "", "const total: number = add(1, 2);", "const bad: number = 'oops';", ""].join("\n"),
      "utf-8"
    );
    writeFileSync(
      path.join(fixture, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, target: "ES2020", module: "ESNext", moduleResolution: "Bundler" } }),
      "utf-8"
    );

    const server = new TsLanguageServer({ cliPath: CLI, nodeCommand: process.execPath });
    try {
      await server.openWorkspace(fixture);
      expect(server.currentStatus.state).toBe("ready");

      // 打开两个文档（未保存缓冲区语义，真实 IDE 行为）
      const mainText = ["import { add } from './math';", "", "const total: number = add(1, 2);", "const bad: number = 'oops';", ""].join("\n");
      server.didOpen("math.ts", ["export function add(a: number, b: number): number {", "  return a + b;", "}", ""].join("\n"));
      server.didOpen("main.ts", mainText);

      // hover：add 调用处（main.ts 第 2 行，"add" 起始列 24）
      const hover = await server.hover("main.ts", 2, 25);
      expect(hover).not.toBeNull();
      expect(hover?.text).toContain("add");

      // definition：调用处 → math.ts 第 0 行
      const defs = await server.definition("main.ts", 2, 25);
      expect(defs.length).toBeGreaterThan(0);
      expect(defs[0]?.file).toBe("math.ts");
      expect(defs[0]?.line).toBe(0);

      // diagnostics：等待服务器推送（类型错误 'oops' → TS2322）
      const deadline = Date.now() + 20_000;
      let items = server.listDiagnostics();
      while (Date.now() < deadline && !items.some((d) => d.file === "main.ts" && d.severity === "error")) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        items = server.listDiagnostics();
      }
      const error = items.find((d) => d.file === "main.ts" && d.severity === "error");
      expect(error).toBeDefined();
      expect(error?.line).toBe(3);
      expect(error?.message.toLowerCase()).toContain("not assignable");

      // completion：add 调用前触发补全，应返回作用域内的 add 候选
      const completions = await server.completion("main.ts", 2, 22);
      expect(completions.length).toBeGreaterThan(0);
      const addCompletion = completions.find((c) => c.label === "add");
      expect(addCompletion).toBeDefined();
    } finally {
      await server.shutdown();
      expect(server.currentStatus.state).toBe("idle");
    }
  }, 60_000);
});
