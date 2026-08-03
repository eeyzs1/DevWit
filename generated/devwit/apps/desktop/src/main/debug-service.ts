/**
 * DebugMainService（迭代 33 / AC42）：主进程 DAP 调试门面。
 * 全局单例 JsDebugSession（真实 js-debug 适配器，vendor 官方发行版 v1.102.0 MIT），
 * 状态/输出变化即时推送 debug:state / debug:output。
 *
 * 零系统依赖：适配器服务器与被调试进程均跑在 Electron-as-node
 * （process.execPath + ELECTRON_RUN_AS_NODE），用户机器无需安装 Node.js。
 *
 * 打包环境路径：dapDebugServer.js 必须落在 app.asar.unpacked（asar 内文件对 spawn
 * 的子进程不可读），app 根路径命中 asar 时替换为 unpacked 对应物
 * （electron-builder.yml files/asarUnpack 已声明 vendor/js-debug 子集）。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IPC } from "@devwit/contracts";
import type { DebugBreakpoint, DebugScopeItem, DebugStackFrameItem, DebugStateInfo, DebugVariableItem } from "@devwit/contracts";
import { JsDebugSession } from "@devwit/dap";

export interface DebugMainServiceDeps {
  /** 主→渲染推送（状态与输出变化）。 */
  send(channel: string, ...args: unknown[]): void;
  /** 测试注入：dapDebugServer.js 绝对路径（缺省走 vendor 生产解析）。 */
  serverPath?: string;
  /** 测试注入：node 可执行（缺省 process.execPath + ELECTRON_RUN_AS_NODE）。 */
  nodeCommand?: string;
  requestTimeoutMs?: number;
}

/** 解析 vendor/js-debug dapDebugServer.js（app 根命中 asar → unpacked 替换）。 */
export function resolveJsDebugServer(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dev：apps/desktop/dist/main → 四级上溯到仓库根；
  // 打包：app.asar/apps/desktop/dist/main → 四级上溯到 app.asar 根（结构同构）
  const appRoot = path.resolve(here, "..", "..", "..", "..");
  const resolved = path.join(appRoot, "vendor", "js-debug", "src", "dapDebugServer.js");
  // app.asar.unpacked 目录由 electron-builder asarUnpack 保证存在
  return resolved.includes("app.asar") ? resolved.replace("app.asar", "app.asar.unpacked") : resolved;
}

/**
 * DAP 调试服务单实例：持有 JsDebugSession，转发状态/输出推送，
 * 向 IPC 层暴露调试控制与查询方法（会话全局单例，start 冲突抛 DW_DAP_ALREADY_ACTIVE）。
 */
export class DebugMainService {
  private session: JsDebugSession | null = null;
  private current: DebugStateInfo = { state: "idle" };

  constructor(private readonly deps: DebugMainServiceDeps) {}

  async start(program: string, breakpoints: Record<string, DebugBreakpoint[]>): Promise<void> {
    if (this.session !== null && this.session.isActive) {
      throw new Error("DW_DAP_ALREADY_ACTIVE");
    }
    // 前会话已 terminated 但未清理：先收尾再新建（幂等）
    if (this.session !== null) {
      await this.session.shutdown();
      this.session = null;
    }
    const session = new JsDebugSession({
      serverPath: this.deps.serverPath ?? resolveJsDebugServer(),
      nodeCommand: this.deps.nodeCommand ?? process.execPath,
      ...(this.deps.requestTimeoutMs !== undefined ? { requestTimeoutMs: this.deps.requestTimeoutMs } : {}),
    });
    session.onState = (state) => {
      this.current = state;
      this.deps.send(IPC.DebugState, state);
    };
    session.onOutput = (category, text) => {
      this.deps.send(IPC.DebugOutput, category, text);
    };
    this.session = session;
    try {
      await session.start(program, breakpoints);
    } catch (error) {
      // 启动失败：会话已内部 shutdown，清空引用并传播 ASCII 错误码
      this.session = null;
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /** 附加到已运行进程（v0.4.0）：连接到指定端口的 Node.js inspector。 */
  async attach(port: number, host: string, breakpoints: Record<string, DebugBreakpoint[]>): Promise<void> {
    if (this.session !== null && this.session.isActive) {
      throw new Error("DW_DAP_ALREADY_ACTIVE");
    }
    if (this.session !== null) {
      await this.session.shutdown();
      this.session = null;
    }
    const session = new JsDebugSession({
      serverPath: this.deps.serverPath ?? resolveJsDebugServer(),
      nodeCommand: this.deps.nodeCommand ?? process.execPath,
      ...(this.deps.requestTimeoutMs !== undefined ? { requestTimeoutMs: this.deps.requestTimeoutMs } : {}),
    });
    session.onState = (state) => {
      this.current = state;
      this.deps.send(IPC.DebugState, state);
    };
    session.onOutput = (category, text) => {
      this.deps.send(IPC.DebugOutput, category, text);
    };
    this.session = session;
    try {
      await session.attach(port, host, breakpoints);
    } catch (error) {
      this.session = null;
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  async stop(): Promise<void> {
    if (this.session !== null) {
      await this.session.shutdown();
    }
  }

  getState(): DebugStateInfo {
    return this.session?.currentState ?? { state: "idle" };
  }

  continue(): Promise<void> {
    return this.requireSession().continue();
  }

  /** 动态更新断点（会话进行中可调用；全量替换语义）。 */
  setBreakpoints(file: string, breakpoints: DebugBreakpoint[]): Promise<void> {
    return this.requireSession().setBreakpoints(file, breakpoints);
  }

  next(): Promise<void> {
    return this.requireSession().next();
  }

  stepIn(): Promise<void> {
    return this.requireSession().stepIn();
  }

  stepOut(): Promise<void> {
    return this.requireSession().stepOut();
  }

  stack(): Promise<DebugStackFrameItem[]> {
    return this.requireSession().stack();
  }

  scopes(frameId: number): Promise<DebugScopeItem[]> {
    return this.requireSession().scopes(frameId);
  }

  variables(reference: number): Promise<DebugVariableItem[]> {
    return this.requireSession().variables(reference);
  }

  evaluate(expression: string, frameId?: number): Promise<DebugVariableItem> {
    return this.requireSession().evaluate(expression, frameId);
  }

  /** 应用退出：disconnect 请求 + 超时强杀（同 LSP/MCP 口径，零孤儿进程）。 */
  async shutdown(): Promise<void> {
    await this.stop();
  }

  private requireSession(): JsDebugSession {
    if (this.session === null) {
      throw new Error("DW_DAP_NOT_STOPPED");
    }
    return this.session;
  }
}
