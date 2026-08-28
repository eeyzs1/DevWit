/**
 * 模式作用域注册空间（Fusion Plan v3 — B-WU5）。
 *
 * 借鉴 DSH 的 per-agent scope：插件/包可以把能力注册到**某个模式**的作用域内，
 * 隔离保证——mode A 注册的条目在 mode B 下不可见。注册即热生效（下一次
 * modeStore/agent-loop 读取立刻可见，无需重启）。注销即回滚（unwind）。
 *
 * kind 标签划分注册类别（后续各自被消费方读取）：
 * - "prompt_section" → 该模式的系统提示段（喂给 context-engine PromptSectionRegistry）
 * - "tool"          → 该模式的动态工具（喂给 agent-loop extraTools）
 * - "context_source"→ 该模式的上下文源（喂给 context-engine registerSource）
 */

export type ModeScopeKind = "prompt_section" | "tool" | "context_source";

export interface ModeScopeEntry<T = unknown> {
  readonly modeId: string;
  readonly kind: ModeScopeKind;
  readonly key: string;
  readonly value: T;
  readonly registeredAt: string;
}

/** per-mode 作用域注册表：隔离 + 热更新 + 可注销。 */
export class ModeScopeRegistry {
  private readonly entries = new Map<string, ModeScopeEntry>();

  /**
   * 注册一条模式作用域条目。返回注销函数（unwind）。同 (modeId, kind, key)
   * 重复注册抛错（fail-closed——避免静默覆盖造成隔离泄漏）。
   */
  register<T>(modeId: string, kind: ModeScopeKind, key: string, value: T): () => void {
    const scopeKey = this.scopeKey(modeId, kind, key);
    if (this.entries.has(scopeKey)) {
      throw new Error(`duplicate mode-scope entry: ${scopeKey}`);
    }
    const entry: ModeScopeEntry<T> = {
      modeId,
      kind,
      key,
      value,
      registeredAt: new Date().toISOString(),
    };
    this.entries.set(scopeKey, entry as ModeScopeEntry);
    return () => {
      this.entries.delete(scopeKey);
    };
  }

  unregister(modeId: string, kind: ModeScopeKind, key: string): void {
    this.entries.delete(this.scopeKey(modeId, kind, key));
  }

  /** 某模式某 kind 的全部条目（按注册顺序）。 */
  list<T = unknown>(modeId: string, kind: ModeScopeKind): ModeScopeEntry<T>[] {
    const out: ModeScopeEntry<T>[] = [];
    for (const entry of this.entries.values()) {
      if (entry.modeId === modeId && entry.kind === kind) out.push(entry as ModeScopeEntry<T>);
    }
    return out;
  }

  /** 全量条目（跨模式，供审计/调试）。 */
  all(): ModeScopeEntry[] {
    return [...this.entries.values()];
  }

  /** 便捷访问器：该模式的提示段值列表（B-WU4 消费）。 */
  sectionsOf(modeId: string): string[] {
    return this.list<string>(modeId, "prompt_section").map((e) => e.value);
  }

  /** 便捷访问器：该模式的动态工具（B-WU2 extraTools 消费）。 */
  toolsOf(modeId: string): unknown[] {
    return this.list(modeId, "tool").map((e) => e.value);
  }

  /** 便捷访问器：该模式的上下文源（context-engine registerSource 消费）。 */
  sourcesOf(modeId: string): unknown[] {
    return this.list(modeId, "context_source").map((e) => e.value);
  }

  /** 隔离保证：注册空间不跨模式可见（测试直接断言此不变量）。 */
  private scopeKey(modeId: string, kind: ModeScopeKind, key: string): string {
    return `${modeId}\u0000${kind}\u0000${key}`;
  }
}
