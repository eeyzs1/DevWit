/**
 * js-debug 调试会话（迭代 33 / AC42）：真实 vscode-js-debug 适配器的会话编排。
 *
 * 架构：被调试进程由本类直接 spawn 持有（attach 模式），而非交给 js-debug launch——
 * 关键原因：js-debug launch 会强制删除 ELECTRON_RUN_AS_NODE（dapDebugServer.js 内
 * `ELECTRON_RUN_AS_NODE:null` 硬编码），导致 Electron 被调试进程进入 GUI 模式永不退出，
 * terminated 事件永远不到达。attach 模式下环境变量完全由我们掌控：
 *   被调试进程：runtimeExecutable --inspect-brk=127.0.0.1:PORT program
 *     env 含 ELECTRON_RUN_AS_NODE=1（Electron-as-node，零系统依赖）
 *     stdout/stderr 管道直挂 onOutput（用户输出不经 DAP 转述，零截断零重复）
 *     close 事件 = 进程退出 + stdio 冲刷完成 → terminated 状态的唯一权威来源
 *   --inspect-brk 停在入口等调试器接管：断点设置/configurationDone 完成前程序不跑，零竞态。
 *
 * dapDebugServer.js 是伴随会话（companion session）模型，真实探针验证的握手序列：
 *   根连接 C1：initialize → attach（响应延迟到 configurationDone 后）
 *     → 等 initialized 事件 → configurationDone → attach 响应
 *     → 收 startDebugging 反向请求（arguments.{request,configuration}，含 __pendingTargetId）
 *   伴随连接 C2（真实调试会话，直连同一服务器）：initialize → request(configuration 原样转发)
 *     → 应答 C1 的 startDebugging 成功 → 等 initialized 事件
 *     → setBreakpoints（真实断点必须设在 C2，C1 的不转移）→ configurationDone → 响应
 * 断点/栈/变量/步进/求值事件全在 C2；C1 仅作启动引导 + 服务器进程载体。
 *
 * 零系统依赖：服务器与被调试进程都跑在 Electron 二进制上（ELECTRON_RUN_AS_NODE），
 * 用户机无需装 Node。生命周期：will-quit/用户停止 → C2/C1 disconnect + 强杀服务器
 * + 强杀被调试进程，零孤儿进程（同 LSP/MCP 口径）。
 * 状态机：idle → starting → running ⇄ stopped → terminated。
 */
import { EventEmitter } from "node:events";
import net from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { DebugBreakpoint } from "@devwit/contracts";
import {
  DapClient,
  nodeDebuggeeSpawnFactory,
  nodeSpawnFactory,
  type DapChildProcess,
  type DapSpawnFactory,
  type DapTransportFactory,
  type DebuggeeProcess,
  type DebuggeeSpawnFactory,
} from "./dap-client.js";
import { tcpConnectTransportFactory, tcpServerTransportFactory } from "./tcp-transport.js";

/**
 * DebugBreakpoint → DAP setBreakpoints 请求项。
 * - condition：求值为真才暂停（DAP condition 字段）。
 * - hitCount：转字符串作为 hitCondition（js-debug 接受 "5" / ">=10" / "%2" 等表达式）。
 * - logMessage：日志断点（DAP logMessage 字段），打印不暂停——适配器内部转 hitCondition=1 + condition。
 * 三字段全缺省 = 普通断点（仅 line）。
 */
function toDapBreakpoint(bp: DebugBreakpoint): Record<string, unknown> {
  const payload: Record<string, unknown> = { line: bp.line };
  if (bp.condition !== undefined && bp.condition !== "") {
    payload["condition"] = bp.condition;
  }
  if (bp.hitCount !== undefined && bp.hitCount > 0) {
    payload["hitCondition"] = String(bp.hitCount);
  }
  if (bp.logMessage !== undefined && bp.logMessage !== "") {
    payload["logMessage"] = bp.logMessage;
  }
  return payload;
}

/** 调试状态（主→渲染推送 + 状态栏展示）。file/line 仅在 stopped 时存在（1-based 行）。 */
export type DebugState =
  | { state: "idle" }
  | { state: "starting" }
  | { state: "running" }
  | { state: "stopped"; threadId: number; reason: string; file?: string; line?: number }
  | { state: "terminated"; exitCode?: number };

/** 调用栈帧（stackTrace 响应项归一化）。 */
export interface DebugStackFrame {
  id: number;
  name: string;
  /** 源文件绝对路径（无源码帧缺省）。 */
  file?: string;
  /** 1-based 行号。 */
  line: number;
  column: number;
}

/** 作用域（scopes 响应项）。 */
export interface DebugScope {
  name: string;
  variablesReference: number;
}

/** 变量（variables/evaluate 响应项归一化；variablesReference > 0 可展开）。 */
export interface DebugVariable {
  name: string;
  value: string;
  variablesReference: number;
}

export interface JsDebugSessionOptions {
  /** dapDebugServer.js 绝对路径（vendor/js-debug/src 内）。 */
  serverPath: string;
  /** node 可执行（生产=process.execPath + ELECTRON_RUN_AS_NODE）。 */
  nodeCommand: string;
  /** 被调试进程的 node 运行时（缺省同 nodeCommand；测试可注入真 node）。 */
  runtimeExecutable?: string;
  spawnImpl?: DapSpawnFactory;
  /** 被调试进程 spawn 注入（测试可假进程驱动退出路径）。 */
  debuggeeSpawnImpl?: DebuggeeSpawnFactory;
  /** 传输工厂（缺省 TCP——dapDebugServer 只讲 TCP；测试可注入 stdio）。 */
  transportFactory?: DapTransportFactory;
  requestTimeoutMs?: number;
  /** js-debug 内部 trace 日志（诊断用，经 output 事件回传）。 */
  trace?: boolean;
}

interface DapStoppedBody {
  threadId?: number;
  reason?: string;
  allThreadsStopped?: boolean;
}

interface DapExitedBody {
  exitCode?: number;
}

interface DapStackFrame {
  id: number;
  name: string;
  line: number;
  column: number;
  source?: { path?: string };
}

/** node inspector 横幅行：不进用户输出面板（纯调试器噪音）。 */
const INSPECTOR_NOISE = /^(For help, see: |Debugger attached\.|Debugger ending\.|Waiting for the debugger to disconnect)/;

/**
 * 伴随连接的空壳进程门面：C2 直连已在运行的 js-debug 服务器（第二次 socket），
 * 不 spawn 新进程——仅满足 DapClient 的进程接口，服务器生命周期由 C1 持有。
 */
class CompanionProcFacade extends EventEmitter implements DapChildProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  kill(): void {
    // 不拥有进程：kill 仅触发 exit 让 DapClient.close 的退出等待立即完成
    queueMicrotask(() => this.emit("exit", null));
  }
}

/** 带超时的等待（伴随会话未如期建立时拒绝，防 start 悬挂）。 */
function withTimeout(promise: Promise<unknown>, ms: number, code: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(code)), ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

/** 取系统空闲端口（被调试进程 inspector 监听用）。 */
function pickPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export class JsDebugSession {
  /** C2 伴随连接：真实调试会话（断点/栈/变量/步进/求值全在这条上）。 */
  private client: DapClient | null = null;
  /** C1 根连接：启动引导 + js-debug 服务器进程载体。 */
  private rootClient: DapClient | null = null;
  /** 被调试进程（本类直接持有；close = 退出 + stdio 冲刷完成）。 */
  private debuggee: DebuggeeProcess | null = null;
  /** 被调试进程 close 兑现句柄（stopDebuggee 等待用）。 */
  private debuggeeClosed: Promise<void> | null = null;
  /** 被调试进程退出码（close 事件记录；terminated 状态携带）。 */
  private debuggeeExitCode: number | null = null;
  private current: DebugState = { state: "idle" };
  private stopThreadId: number | null = null;
  /** C2 initialized 事件闸（start 内 await；setBreakpoints 必须等它）。 */
  private initializedGate: (() => void) | null = null;
  /** C2 attach/launch 请求句柄（响应延迟到 C2 configurationDone 后，start 尾段 await）。 */
  private companionRequest: Promise<unknown> | null = null;
  /**
   * entry pause 兜底标记：--inspect-brk 的 break-on-start 暂停。
   * 探针实测 js-debug 行为分裂：entry pause 先于 configurationDone 到达 → 适配器自 resume
   * （有断点路径，continued 事件直接来）；后于 configurationDone 到达 → 适配器上报
   * stopped(reason=pause) 不再 resume（无断点路径）。客户端统一兜底：启动后首个 stopped
   * 若 reason=pause 即 entry pause，自动 continue（对用户透明，不上报 stopped 态）。
   */
  private pendingEntryResume = false;

  /** 状态变化回调（主→渲染推送）。 */
  onState: ((state: DebugState) => void) | null = null;
  /** 被调试进程输出回调（stdout/stderr 管道直挂）。 */
  onOutput: ((category: string, text: string) => void) | null = null;
  /** 原始 DAP 事件探针（诊断用；channel 区分 root/companion 连接）。 */
  onRawEvent: ((channel: string, event: string, body: unknown) => void) | null = null;

  constructor(private readonly options: JsDebugSessionOptions) {}

  get currentState(): DebugState {
    return this.current;
  }

  /** 当前是否处于调试会话中（running/stopped；terminated 后视为可重启）。 */
  get isActive(): boolean {
    return this.current.state === "starting" || this.current.state === "running" || this.current.state === "stopped";
  }

  /**
   * 启动调试：program 为入口文件绝对路径；breakpoints 为 绝对路径 → DebugBreakpoint[]
   * （1-based 行号；可携带 condition/hitCount/logMessage）。
   * 完整握手完成后 resolve（此刻程序可能已在跑或已停在首断点）。
   */
  async start(program: string, breakpoints: Record<string, DebugBreakpoint[]>): Promise<void> {
    if (this.isActive) throw new Error("DW_DAP_ALREADY_ACTIVE");
    this.setState({ state: "starting" });
    const timeout = this.options.requestTimeoutMs ?? 30_000;

    // ---- 被调试进程先行：--inspect-brk 停在入口，等调试器接管（断点零竞态）----
    const port = await pickPort();
    const { inspectorReady } = this.spawnDebuggee(program, port);

    // ---- C1 根连接：spawn js-debug 服务器（port=0 系统分配，多会话不撞车） ----
    const root = new DapClient(
      this.options.nodeCommand,
      [this.options.serverPath, "0", "127.0.0.1"],
      { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      this.options.spawnImpl ?? nodeSpawnFactory,
      timeout,
      this.options.transportFactory ?? tcpServerTransportFactory()
    );
    this.rootClient = root;
    root.onExit = () => {
      // 服务器进程死 → 整会话终结；被调试进程一并杀（防停在入口成孤儿）
      void this.stopDebuggee();
      if (this.current.state !== "idle" && this.current.state !== "terminated") {
        this.stopThreadId = null;
        this.setState({ state: "terminated" });
      }
      void this.closeClients();
    };

    try {
      await root.start();
      const address = root.transportAddress;
      if (address === null) throw new Error("DW_DAP_TRANSPORT_DEAD");

      // startDebugging 反向请求：js-debug 要求客户端开伴随连接跑真实会话。
      // 处理器内完成 C2 initialize + 发出 C2 attach 后才应答成功（适配器等此应答才发 C2 initialized）。
      root.onReverseRequest = async (command, args) => {
        if (command !== "startDebugging") throw new Error("DW_DAP_REVERSE_UNSUPPORTED");
        const payload = args as { request?: string; configuration?: Record<string, unknown> } | undefined;
        if (payload?.configuration === undefined || typeof payload.request !== "string" || payload.request === "") {
          throw new Error("DW_DAP_REVERSE_BAD_ARGS");
        }
        await this.startCompanion(address, payload.request, payload.configuration, timeout);
        return {};
      };
      let rootGate: () => void = () => {};
      const rootInitialized = new Promise<void>((resolve) => {
        rootGate = resolve;
      });
      root.onEvent = (event, body) => {
        this.onRawEvent?.("root", event, body);
        if (event === "initialized") rootGate();
      };

      // C2 initialized 闸（必须在 C1 attach 前挂好——startDebugging 随时可能到）
      const companionReady = new Promise<void>((resolve) => {
        this.initializedGate = () => resolve();
      });

      // inspector 端口就绪后再发起 attach（js-debug attach 自身也有 timeout 重试，双保险；
      // 提前崩溃（程序路径错等）在此即以真实 stderr 尾部报错，而非悬挂到适配器超时）
      await withTimeout(inspectorReady, Math.min(timeout, 10_000), "DW_DAP_INSPECTOR_TIMEOUT");

      // ---- C1 握手：attach → 等 initialized → configurationDone → attach 响应 ----
      const rootAttach = root.request("attach", {
        type: "pwa-node",
        request: "attach",
        name: "DevWit Debug",
        address: "127.0.0.1",
        port,
        stopOnEntry: false,
        // 首迭代不打 sourcemap（.ts 直跑由用户自行编译）；js 断点即真断点
        resolveSourceMapLocations: null,
        sourceMaps: false,
        timeout: Math.min(timeout, 10_000),
        ...(this.options.trace === true ? { trace: true } : {}),
      });
      rootAttach.catch(() => {}); // 拒绝统一在下方 await 处冒泡，防 unhandled rejection
      await rootInitialized;
      await root.request("configurationDone");
      await rootAttach;

      // ---- C2 已由 startDebugging 建立：等 initialized → 设断点 → configurationDone → attach 响应 ----
      await withTimeout(companionReady, timeout, "DW_DAP_COMPANION_TIMEOUT");
      const companion = this.client;
      const companionRequest = this.companionRequest;
      if (companion === null || companionRequest === null) throw new Error("DW_DAP_COMPANION_MISSING");
      this.initializedGate = null;
      for (const [file, bps] of Object.entries(breakpoints)) {
        if (bps.length === 0) continue;
        await companion.request("setBreakpoints", {
          source: { path: file },
          breakpoints: bps.map((bp) => toDapBreakpoint(bp)),
        });
      }
      // entry pause 兜底武装：configurationDone 后 entry pause 才到适配器时会被上报 stopped(pause)
      this.pendingEntryResume = true;
      await companion.request("configurationDone");
      await companionRequest; // C2 attach 响应（此刻程序在跑或已停首断点）
      if (this.current.state === "starting") {
        this.setState({ state: "running" });
      }
    } catch (error) {
      await this.shutdown();
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /** 停止调试（C2/C1 disconnect + 强杀服务器 + 强杀被调试进程；幂等）。 */
  async shutdown(): Promise<void> {
    this.initializedGate = null;
    this.stopThreadId = null;
    this.pendingEntryResume = false;
    await this.closeClients();
    await this.stopDebuggee();
    if (this.current.state !== "idle") {
      this.setState({ state: "terminated" });
    }
  }

  /**
   * 被调试进程 spawn + IO 接线。
   * --inspect-brk 停在入口等接管；stdout 直挂 onOutput；stderr 过滤 inspector 横幅后直挂；
   * close 事件是 terminated 状态的唯一权威来源（进程退出 + stdio 冲刷完成）。
   */
  private spawnDebuggee(program: string, port: number): { inspectorReady: Promise<void> } {
    const spawnImpl = this.options.debuggeeSpawnImpl ?? nodeDebuggeeSpawnFactory;
    const debuggee = spawnImpl(
      this.options.runtimeExecutable ?? this.options.nodeCommand,
      [`--inspect-brk=127.0.0.1:${port}`, program],
      // ELECTRON_RUN_AS_NODE：Electron-as-node 零系统依赖（js-debug launch 会删它，attach 模式由我们掌控）
      { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      path.dirname(program)
    );
    this.debuggee = debuggee;
    this.debuggeeExitCode = null;
    let closedResolve: () => void = () => {};
    this.debuggeeClosed = new Promise<void>((resolve) => {
      closedResolve = resolve;
    });

    let stderrTail = "";
    let stderrLineBuf = "";
    let ready = false;
    let resolveReady: () => void = () => {};
    let rejectReady: (error: Error) => void = () => {};
    const inspectorReady = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    debuggee.stdout.on("data", (chunk: Buffer) => {
      this.onOutput?.("stdout", chunk.toString("utf-8"));
    });
    debuggee.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      stderrTail = (stderrTail + text).slice(-2000);
      stderrLineBuf += text;
      const lines = stderrLineBuf.split("\n");
      stderrLineBuf = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.replace(/\r$/, "");
        if (!ready && line.startsWith("Debugger listening on ")) {
          ready = true;
          resolveReady();
          continue; // inspector 横幅不进输出面板
        }
        if (line === "" || INSPECTOR_NOISE.test(line)) continue;
        this.onOutput?.("stderr", line + "\n");
      }
    });
    debuggee.on("error", (error) => {
      if (!ready) {
        ready = true;
        rejectReady(new Error(`DW_DAP_DEBUGGEE_SPAWN_FAILED:${error.message}`));
      }
      closedResolve();
    });
    debuggee.on("close", (code) => {
      if (!ready) {
        ready = true;
        // 入口文件不存在等提前崩溃：stderr 尾部即真实死因（非 ASCII 剥离——IPC 错误串禁中文）
        const tail = stderrTail
          .replace(/[^\x20-\x7E]/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(-300);
        rejectReady(new Error(`DW_DAP_DEBUGGEE_EXIT:${code ?? "signal"}${tail === "" ? "" : `:${tail}`}`));
      }
      this.debuggeeExitCode = code;
      closedResolve();
      this.pendingEntryResume = false;
      if (this.current.state !== "idle" && this.current.state !== "terminated") {
        this.stopThreadId = null;
        this.setState({ state: "terminated", ...(code !== null ? { exitCode: code } : {}) });
      }
      void this.closeClients();
    });
    return { inspectorReady };
  }

  /** 强杀被调试进程并等 close（3s 上限）；未 spawn/已退出即返回。幂等。 */
  private async stopDebuggee(): Promise<void> {
    const debuggee = this.debuggee;
    const closed = this.debuggeeClosed;
    this.debuggee = null;
    this.debuggeeClosed = null;
    if (debuggee === null || closed === null) return;
    try {
      debuggee.kill();
    } catch {
      // 已退出：noop
    }
    await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
  }

  /** 伴随连接 C2：直连同一 js-debug 服务器，initialize → request(configuration 原样转发)。 */
  private async startCompanion(
    address: { host: string; port: number },
    command: string,
    configuration: Record<string, unknown>,
    timeoutMs: number
  ): Promise<void> {
    const facade = new CompanionProcFacade();
    const companion = new DapClient(
      "js-debug-companion",
      [],
      {},
      () => facade,
      timeoutMs,
      tcpConnectTransportFactory(address.host, address.port)
    );
    companion.onEvent = (event, body) => {
      this.onRawEvent?.("companion", event, body);
      this.handleEvent(event, body);
    };
    companion.onExit = () => {
      // C2 socket 断开（服务器死/异常）：会话进行中的话终结并收尾
      if (this.current.state === "starting" || this.current.state === "running" || this.current.state === "stopped") {
        this.stopThreadId = null;
        this.setState({ state: "terminated" });
        void this.stopDebuggee();
        void this.closeClients();
      }
    };
    await companion.start();
    this.client = companion;
    // C2 请求：响应延迟到 configurationDone 后；失败在 start 尾段 await 统一冒泡
    const requested = companion.request(command, configuration);
    requested.catch(() => {});
    this.companionRequest = requested;
  }

  /** 关闭双连接（先摘回调防关闭路径重入状态回调；C1 关闭即强杀服务器进程）。 */
  private async closeClients(): Promise<void> {
    const companion = this.client;
    const root = this.rootClient;
    this.client = null;
    this.rootClient = null;
    this.companionRequest = null;
    if (companion !== null) {
      companion.onEvent = null;
      companion.onExit = null;
      companion.onReverseRequest = null;
      await companion.close();
    }
    if (root !== null) {
      root.onEvent = null;
      root.onExit = null;
      root.onReverseRequest = null;
      await root.close();
    }
  }

  /** 以下步进/查询方法要求 stopped 态（threadId 取最近 stopped 事件的线程）。 */
  private requireStopped(): { client: DapClient; threadId: number } {
    const client = this.client;
    const threadId = this.stopThreadId;
    if (client === null || threadId === null || this.current.state !== "stopped") {
      throw new Error("DW_DAP_NOT_STOPPED");
    }
    return { client, threadId };
  }

  async continue(): Promise<void> {
    const { client, threadId } = this.requireStopped();
    await client.request("continue", { threadId });
    this.stopThreadId = null;
    this.setState({ state: "running" });
  }

  async next(): Promise<void> {
    const { client, threadId } = this.requireStopped();
    this.stopThreadId = null;
    this.setState({ state: "running" });
    await client.request("next", { threadId });
  }

  async stepIn(): Promise<void> {
    const { client, threadId } = this.requireStopped();
    this.stopThreadId = null;
    this.setState({ state: "running" });
    await client.request("stepIn", { threadId });
  }

  async stepOut(): Promise<void> {
    const { client, threadId } = this.requireStopped();
    this.stopThreadId = null;
    this.setState({ state: "running" });
    await client.request("stepOut", { threadId });
  }

  /**
   * 动态更新断点（会话进行中可调用；空数组=清除该文件全部断点）。
   * 全量替换语义：未列出行的既有断点会被清除。
   */
  async setBreakpoints(file: string, breakpoints: DebugBreakpoint[]): Promise<void> {
    const client = this.client;
    if (client === null) throw new Error("DW_DAP_NOT_RUNNING");
    await client.request("setBreakpoints", {
      source: { path: file },
      breakpoints: breakpoints.map((bp) => toDapBreakpoint(bp)),
    });
  }

  /** 调用栈（stopped 态）。 */
  async stack(): Promise<DebugStackFrame[]> {
    const { client, threadId } = this.requireStopped();
    const body = (await client.request("stackTrace", { threadId, startFrame: 0, levels: 50 })) as
      | { stackFrames?: DapStackFrame[] }
      | undefined;
    return (body?.stackFrames ?? []).map((frame) => ({
      id: frame.id,
      name: frame.name,
      ...(frame.source?.path !== undefined ? { file: frame.source.path } : {}),
      line: frame.line,
      column: frame.column,
    }));
  }

  /** 作用域列表（指定帧）。 */
  async scopes(frameId: number): Promise<DebugScope[]> {
    const client = this.client;
    if (client === null || this.current.state !== "stopped") throw new Error("DW_DAP_NOT_STOPPED");
    const body = (await client.request("scopes", { frameId })) as
      | { scopes?: Array<{ name: string; variablesReference: number; expensive?: boolean }> }
      | undefined;
    return (body?.scopes ?? [])
      .filter((scope) => scope.expensive !== true)
      .map((scope) => ({ name: scope.name, variablesReference: scope.variablesReference }));
  }

  /** 变量列表（作用域或子对象引用；>100 截断防大卡）。 */
  async variables(reference: number): Promise<DebugVariable[]> {
    const client = this.client;
    if (client === null || this.current.state !== "stopped") throw new Error("DW_DAP_NOT_STOPPED");
    const body = (await client.request("variables", { variablesReference: reference })) as
      | { variables?: Array<{ name: string; value: string; variablesReference: number }> }
      | undefined;
    return (body?.variables ?? []).slice(0, 100).map((v) => ({
      name: v.name,
      value: v.value,
      variablesReference: v.variablesReference,
    }));
  }

  /** 表达式求值（暂停上下文；frameId 缺省取当前栈顶帧）。 */
  async evaluate(expression: string, frameId?: number): Promise<DebugVariable> {
    const client = this.client;
    if (client === null || this.current.state !== "stopped") throw new Error("DW_DAP_NOT_STOPPED");
    // 未指定帧时默认栈顶帧（调试控制台口径）——无帧 repl 求值 js-debug 直接拒答
    let targetFrame = frameId;
    if (targetFrame === undefined) {
      const frames = await this.stack();
      targetFrame = frames[0]?.id;
    }
    const body = (await client.request("evaluate", {
      expression,
      ...(targetFrame !== undefined ? { frameId: targetFrame } : {}),
      context: "repl",
    })) as { result?: string; variablesReference?: number } | undefined;
    return {
      name: expression,
      value: body?.result ?? "",
      variablesReference: body?.variablesReference ?? 0,
    };
  }

  // --------------------------------------------------------------------------
  // 事件归一化（全部来自 C2；C1 仅 initialized 由 start 内联处理。
  // 用户程序输出不经 DAP——stdout/stderr 管道直挂 onOutput，DAP output 事件不转发，
  // 避免与 CDP console 捕获重复）
  // --------------------------------------------------------------------------

  private handleEvent(event: string, body: unknown): void {
    if (event === "initialized") {
      this.initializedGate?.();
      return;
    }
    if (event === "stopped") {
      const stopped = (body ?? {}) as DapStoppedBody;
      const threadId = stopped.threadId ?? 1;
      const reason = stopped.reason ?? "breakpoint";
      // entry pause 兜底：启动后首个 stopped 且 reason=pause → --inspect-brk 的 break-on-start，
      // 自动 continue（对用户透明）。用户 debugger 语句 reason=debugger statement，不误伤。
      if (this.pendingEntryResume) {
        this.pendingEntryResume = false;
        if (reason === "pause") {
          const client = this.client;
          if (client !== null) {
            void client.request("continue", { threadId }).catch(() => {});
            return;
          }
        }
      }
      this.stopThreadId = threadId;
      // 栈顶文件/行异步补齐（不阻塞事件分发；失败仅缺定位不阻塞调试）
      this.setState({ state: "stopped", threadId, reason });
      void this.fillTopFrame(threadId);
      return;
    }
    if (event === "continued") {
      this.stopThreadId = null;
      this.setState({ state: "running" });
      return;
    }
    if (event === "terminated") {
      this.pendingEntryResume = false;
      this.stopThreadId = null;
      // 被调试进程 close 通常先到：保留已记录的 exitCode
      const exitCode = this.current.state === "terminated" ? this.current.exitCode : this.debuggeeExitCode;
      this.setState({ state: "terminated", ...(exitCode !== null && exitCode !== undefined ? { exitCode } : {}) });
      void this.closeClients();
      return;
    }
    if (event === "exited") {
      const exited = (body ?? {}) as DapExitedBody;
      this.setState({ state: "terminated", ...(exited.exitCode !== undefined ? { exitCode: exited.exitCode } : {}) });
      return;
    }
    if (event === "output") {
      // v0.4.0：日志断点（logMessage）输出经 DAP output 事件回传（category="console"），
      // 不经被调试进程 stdout——必须转发否则日志断点输出丢失。
      // console.log 等用户输出已由 stdout/stderr 管道直挂（零截断零重复），不在此转发，
      // 仅转发 category="console" 的日志断点输出（避免与 stdout 重复）。
      const out = (body ?? {}) as { category?: string; output?: string };
      if (out.category === "console" && typeof out.output === "string" && out.output.length > 0) {
        this.onOutput?.("console", out.output);
      }
      return;
    }
  }

  /** 栈顶帧定位补齐（stopped 态的 file/line；竞态容忍——期间继续/退出则静默丢弃）。 */
  private async fillTopFrame(threadId: number): Promise<void> {
    const client = this.client;
    if (client === null) return;
    try {
      const body = (await client.request("stackTrace", { threadId, startFrame: 0, levels: 1 })) as
        | { stackFrames?: DapStackFrame[] }
        | undefined;
      const top = body?.stackFrames?.[0];
      if (top === undefined) return;
      if (this.current.state !== "stopped" || this.current.threadId !== threadId) return;
      this.setState({
        state: "stopped",
        threadId,
        reason: this.current.reason,
        ...(top.source?.path !== undefined ? { file: top.source.path } : {}),
        line: top.line,
      });
    } catch {
      // 适配器竞态断开：定位缺失不影响调试主流程
    }
  }

  private setState(state: DebugState): void {
    this.current = state;
    this.onState?.(state);
  }
}
