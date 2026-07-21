import { getEncoding } from "js-tiktoken";

/**
 * Token 计数器抽象。
 * exact=true 表示 BPE 精确计数；exact=false 表示估算（UI 需在 manifest 上标注）。
 */
export interface TokenCounter {
  readonly name: string;
  readonly exact: boolean;
  count(text: string): number;
}

/**
 * 精确计数器：js-tiktoken 的 cl100k_base 编码（OpenAI 系模型的真实 BPE）。
 */
export class TiktokenCounter implements TokenCounter {
  readonly name = "cl100k_base";
  readonly exact = true;
  private readonly encoding: ReturnType<typeof getEncoding>;

  constructor() {
    this.encoding = getEncoding("cl100k_base");
  }

  count(text: string): number {
    if (text.length === 0) return 0;
    return this.encoding.encode(text).length;
  }
}

/**
 * 估算计数器：Anthropic 未公开其 BPE，无本地精确计数手段。
 * 复用 cl100k_base 的计数结果作为估算值，并诚实标注 exact=false（UI 显示"估算"）。
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
}
