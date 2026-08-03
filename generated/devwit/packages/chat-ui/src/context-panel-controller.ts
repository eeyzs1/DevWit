import type { ContextItemType, ContextManifest, DevwitApi } from "@devwit/contracts";

/**
 * ContextPanelController（WU012 / AC2）：上下文组成面板的 headless 模型。
 * - refresh()：拉取当前策略视图（引擎默认 ← 模式策略 ← 用户开关）与最近一份 manifest；
 * - setEnabled(type, enabled)：逐项开关经 IPC 直达 context-engine，实时生效；
 * - 面板数据 = manifest 各项（含 token 计数与计数方式 exact/estimated）叠加策略视图。
 * 不碰 DOM，由 context-panel.ts 渲染。
 */
export interface ContextPanelState {
  /** 类型 → 当前生效开关（含引擎默认值，UI 全量渲染）。 */
  policy: Record<ContextItemType, boolean> | null;
  /** 最近一次请求的上下文清单；尚无请求时为 null。 */
  manifest: ContextManifest | null;
}

export class ContextPanelController {
  private readonly api: DevwitApi;
  private readonly listeners = new Set<() => void>();
  private state: ContextPanelState = { policy: null, manifest: null };

  constructor(api: DevwitApi) {
    this.api = api;
  }

  get current(): ContextPanelState {
    return this.state;
  }

  /** 拉取策略视图 + 最近 manifest（每次请求完成后由集成方调用）。 */
  async refresh(): Promise<ContextPanelState> {
    const [policy, manifest] = await Promise.all([this.api.context.getPolicy(), this.api.context.latestManifest()]);
    this.state = { policy, manifest };
    this.emit();
    return this.state;
  }

  /** 逐项开关：先写引擎（实时生效），再刷新视图模型。 */
  async setEnabled(type: ContextItemType, enabled: boolean): Promise<void> {
    await this.api.context.setItemEnabled(type, enabled);
    await this.refresh();
  }

  /** 稳定 key 项的逐项开关（AC19 codebase_match 单块剔除/恢复）。 */
  async setItemOverride(key: string, enabled: boolean): Promise<void> {
    await this.api.context.setItemOverride(key, enabled);
    await this.refresh();
  }

  /**
   * 导出当前 manifest 为 JSON 文件（v0.4.0 审计导出）。
   * manifestId 缺省时主进程导出最近一份。返回保存路径，取消返回 null。
   */
  async exportCurrent(): Promise<string | null> {
    const id = this.state.manifest?.id;
    return this.api.context.exportManifest(id);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
