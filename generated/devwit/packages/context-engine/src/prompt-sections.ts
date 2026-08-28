/**
 * 系统提示段注册表（Fusion Plan v3 — B-WU4，借鉴 DSH system-prompt 组装）。
 *
 * 系统提示不再是单一字符串：任意插件/包可注册命名段（name/order/text|函数），
 * 每次 build 按 order（同级按名字）协作组装；`complete: true` 段成为唯一系统
 * 提示（>1 个 effective complete 组装失败——fail-closed）。段组成写入 manifest
 * 的 promptSections 字段做审计（AC2 逐项可见语义的延伸）。
 */

export interface PromptSectionAssembleContext {
  modeId: string;
  providerId: string;
  model: string;
}

export interface PromptSection {
  /** 唯一名：重复注册抛错。 */
  name: string;
  /** 段序：升序拼接；同序按 code-unit 名字序。 */
  order: number;
  /** 静态文本或每次组装求值的函数。 */
  text: string | ((ctx: PromptSectionAssembleContext) => string);
  /** true = 该段成为唯一系统提示；>1 个 effective complete → 组装失败。 */
  complete?: boolean;
}

/** 仓库内一方的命名段位分配（避免魔法数字撞序）。 */
export const FIRST_PARTY_SECTION_ORDER = {
  mode: 0,
  tools: 100,
  context: 200,
  safety: 300,
} as const;

function resolveText(section: PromptSection, ctx: PromptSectionAssembleContext): string {
  return typeof section.text === "function" ? section.text(ctx) : section.text;
}

/** 可审计的组装结果：最终系统提示 + 参与段清单（进 manifest）。 */
export interface PromptAssembly {
  text: string;
  sections: Array<{ name: string; order: number }>;
}

/** 系统提示段注册表：注册即参与下一次组装（热生效，无需重建会话）。 */
export class PromptSectionRegistry {
  private readonly sections = new Map<string, PromptSection>();

  /** 注册一段，返回注销函数（unwind 语义）。重复名抛错（fail-closed）。 */
  register(section: PromptSection): () => void {
    if (this.sections.has(section.name)) {
      throw new Error(`duplicate prompt section: ${section.name}`);
    }
    this.sections.set(section.name, section);
    return () => {
      this.sections.delete(section.name);
    };
  }

  unregister(name: string): void {
    this.sections.delete(name);
  }

  /** 当前全部段（按 order 再名字排序）。 */
  list(): PromptSection[] {
    return [...this.sections.values()].sort(
      (a, b) => a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
  }

  /** 组装系统提示。空注册表返回空文本（调用方决定兜底）。 */
  assemble(ctx: PromptSectionAssembleContext): PromptAssembly {
    const ordered = this.list();
    const complete = ordered.filter((s) => s.complete === true);
    if (complete.length > 1) {
      throw new Error(
        `multiple effective complete prompt sections: ${complete.map((s) => s.name).join(", ")}`,
      );
    }
    const sections = ordered.map((s) => ({ name: s.name, order: s.order }));
    if (complete.length === 1) {
      return { text: resolveText(complete[0]!, ctx), sections };
    }
    const text = ordered
      .map((s) => resolveText(s, ctx).trim())
      .filter((t) => t.length > 0)
      .join("\n\n");
    return { text, sections };
  }
}
