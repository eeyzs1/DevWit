import { getEncoding } from "js-tiktoken";

/**
 * Token 计数器抽象。
 * exact=true 表示 BPE 精确计数；exact=false 表示估算（UI 需在 manifest 上标注）。
 * countForModel（可选）：按模型选词典计数（v0.7.2 校准——GPT-4o+ 用 o200k_base，
 * 混用 cl100k 对其系统性高估 5-15%）。缺省回退 count()。
 */
export interface TokenCounter {
  readonly name: string;
  readonly exact: boolean;
  count(text: string): number;
  countForModel?(model: string, text: string): number;
}

/** 按模型名判定 token 词典族：GPT-4o/4.1/o 系/后续 4.x 用 o200k_base，其余 cl100k_base。 */
export function tiktokenFamilyForModel(model: string): "cl100k_base" | "o200k_base" {
  const m = model.toLowerCase();
  if (
    m.startsWith("gpt-4o") ||
    m.startsWith("gpt-4.1") ||
    m.startsWith("gpt-4.5") ||
    m.startsWith("chatgpt-4o") ||
    m.startsWith("o1") ||
    m.startsWith("o3") ||
    m.startsWith("o4")
  ) {
    return "o200k_base";
  }
  return "cl100k_base";
}

/**
 * 模型感知的精确计数器：按模型懒加载 cl100k_base / o200k_base 两套 BPE
 * （编码器构造昂贵，懒加载 + 复用；两套均为真实 BPE，exact=true 诚实成立）。
 * count() 无模型上下文，缺省 cl100k_base（历史行为不变）。
 */
export class TiktokenCounter implements TokenCounter {
  readonly name = "tiktoken(model-aware)";
  readonly exact = true;
  private readonly encodings = new Map<string, ReturnType<typeof getEncoding>>();

  private encodingFor(family: string): ReturnType<typeof getEncoding> {
    let encoding = this.encodings.get(family);
    if (encoding === undefined) {
      encoding = getEncoding(family as Parameters<typeof getEncoding>[0]);
      this.encodings.set(family, encoding);
    }
    return encoding;
  }

  count(text: string): number {
    if (text.length === 0) return 0;
    return this.encodingFor("cl100k_base").encode(text).length;
  }

  countForModel(model: string, text: string): number {
    if (text.length === 0) return 0;
    return this.encodingFor(tiktokenFamilyForModel(model)).encode(text).length;
  }
}

/**
 * 估算计数器：Anthropic 未公开其 BPE，无本地精确计数手段。
 * 复用模型感知计数结果作为估算值，并诚实标注 exact=false（UI 显示"估算"）。
 */
export class EstimatedCounter implements TokenCounter {
  readonly name: string;
  readonly exact = false;
  private readonly inner: TokenCounter;

  constructor(inner?: TokenCounter, name = "cl100k_base(estimated)") {
    this.inner = inner ?? new TiktokenCounter();
    this.name = name;
  }

  count(text: string): number {
    return this.inner.count(text);
  }

  countForModel(model: string, text: string): number {
    return this.inner.countForModel?.(model, text) ?? this.inner.count(text);
  }
}
