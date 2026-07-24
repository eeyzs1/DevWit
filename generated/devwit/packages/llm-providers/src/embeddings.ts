import type { CredentialResolver, Embedder, ProviderConfig } from "@devwit/contracts";
import { asNumber, asString, isRecord, parseJsonObject } from "./guards.js";
import { assertResponseOk, joinUrl } from "./http.js";

/**
 * OpenAI 兼容 /v1/embeddings 客户端（迭代 10 / AC19）。
 *
 * 请求形状：{ model, input: string[] }（批量，单请求多文本）；
 * 响应取 data[*].embedding（按 index 排序回填，与输入等长对齐）。
 * Anthropic 无 embeddings API——createEmbedder 对 anthropic 类型抛
 * DW_EMBED_UNSUPPORTED，由上层（rag 索引）降级为"索引不可用"状态。
 */

export interface OpenAiEmbeddingResponse {
  data: Array<{ index: number; embedding: number[] }>;
  model: string;
}

export function buildEmbeddingRequest(model: string, texts: string[]): { model: string; input: string[] } {
  return { model, input: texts };
}

/** 解析 /v1/embeddings 响应：按 index 对齐输入顺序，缺向量/维度不一致抛错。 */
export function parseEmbeddingResponse(payload: string, expectedCount: number): number[][] {
  const root = parseJsonObject(payload);
  if (root === undefined) {
    throw new Error("DW_EMBED_PARSE_FAILED:openai");
  }
  const data = root["data"];
  if (!Array.isArray(data)) {
    throw new Error("DW_EMBED_PARSE_FAILED:openai");
  }
  const vectors: number[][] = [];
  for (const entry of data) {
    if (!isRecord(entry)) continue;
    const index = asNumber(entry["index"]) ?? vectors.length;
    const raw = entry["embedding"];
    if (!Array.isArray(raw)) continue;
    const vector: number[] = [];
    for (const value of raw) {
      const num = asNumber(value);
      if (num === undefined) throw new Error("DW_EMBED_PARSE_FAILED:openai");
      vector.push(num);
    }
    vectors[index] = vector;
  }
  if (vectors.length !== expectedCount || vectors.some((v) => v === undefined || v.length === 0)) {
    throw new Error("DW_EMBED_PARSE_FAILED:openai");
  }
  const dim = vectors[0]!.length;
  for (const vector of vectors) {
    if (vector.length !== dim) throw new Error("DW_EMBED_DIM_MISMATCH");
  }
  return vectors;
}

export class OpenAiCompatibleEmbedder implements Embedder {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly credentials: CredentialResolver;
  private readonly credentialRef: string;
  private readonly keyless: boolean;

  constructor(config: ProviderConfig, embedModel: string, credentials: CredentialResolver) {
    if (!config.baseUrl) throw new Error("OpenAiCompatibleEmbedder: ProviderConfig.baseUrl is empty");
    this.baseUrl = config.baseUrl;
    this.model = embedModel;
    this.credentials = credentials;
    this.credentialRef = config.credentialRef;
    this.keyless = config.keyless === true;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    // keyless（AC22：本地服务如 Ollama /v1/embeddings）跳过凭证解析与 authorization 头
    const apiKey = this.keyless ? undefined : await this.credentials.resolve(this.credentialRef);
    const response = await fetch(joinUrl(this.baseUrl, "/embeddings"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey !== undefined ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(buildEmbeddingRequest(this.model, texts)),
    });
    await assertResponseOk(response);
    return parseEmbeddingResponse(await response.text(), texts.length);
  }
}

/** 按 provider 类型构造 Embedder；anthropic 等无 embeddings API 的类型抛 DW_EMBED_UNSUPPORTED。 */
export function createEmbedder(
  config: ProviderConfig,
  embedModel: string,
  credentials: CredentialResolver
): Embedder {
  if (config.type === "openai") {
    return new OpenAiCompatibleEmbedder(config, embedModel, credentials);
  }
  // 错误码保持 ASCII：上层 localizeError 按当前语言映射文案
  throw new Error(`DW_EMBED_UNSUPPORTED:${asString(config.type) ?? config.type}`);
}
