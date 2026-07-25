import type { ContextSource, DiagnosticEntry } from "@devwit/contracts";
import { diagnosticsSource } from "@devwit/context-engine";

/**
 * 诊断采集器（迭代 21 / AC30）：由 apps 层注入——主进程真实跑 tsc --noEmit，
 * 返回结构化诊断列表。无 tsconfig / 无本地 typescript / 超时等无法诊断的场景
 * 一律返回空数组（诚实降级：没有诊断能力就不注入，不伪造「无问题」）。
 */
export type DiagnosticsProvider = (workspaceRoot: string) => Promise<DiagnosticEntry[]>;

/**
 * DiagnosticsTracker：编辑后诊断的会话级快照持有者与刷新闸门。
 * - AgentLoop 在 write/edit 工具成功改写文件后调 refresh()；
 * - 注册的 ContextSource 在每轮请求 build 时读最新快照——问题出现即注入下一轮
 *   上下文，修复归零后自动消失（零占位 token）；
 * - provider 抛错（tsc 崩溃/超时杀掉）吞掉并清空快照：诊断是增强回馈，
 *   绝不能阻断 agent 主循环。
 */
export class DiagnosticsTracker {
  private readonly provider?: DiagnosticsProvider;
  private latest: readonly DiagnosticEntry[] = [];
  /** 防止并发 refresh 交错写快照（同一 loop 串行，编排子 Agent 共享时可能并发）。 */
  private refreshing: Promise<void> | null = null;

  constructor(provider?: DiagnosticsProvider) {
    if (provider !== undefined) this.provider = provider;
  }

  /** 是否具备诊断能力（未注入 provider 时 loop 完全跳过刷新，零成本）。 */
  get available(): boolean {
    return this.provider !== undefined;
  }

  getLatest(): readonly DiagnosticEntry[] {
    return this.latest;
  }

  /** 刷新快照：串行化，返回本轮问题数。 */
  async refresh(workspaceRoot: string): Promise<number> {
    const provider = this.provider;
    if (provider === undefined) return 0;
    this.refreshing ??= (async () => {
      try {
        this.latest = await provider(workspaceRoot);
      } catch {
        this.latest = [];
      } finally {
        this.refreshing = null;
      }
    })();
    await this.refreshing;
    return this.latest.length;
  }

  /** 上下文源：挂到会话引擎上，build 时读最新快照。 */
  source(): ContextSource {
    return diagnosticsSource(() => this.latest);
  }
}
