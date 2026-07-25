import type { ProviderType } from "@devwit/contracts";
import { asString, isRecord, safeParseJson } from "./guards.js";
import { joinUrl } from "./http.js";

// ============================================================================
// 连接探测（迭代 17 / AC26）：设置页「测试连接」的真实实现。
// 轻量 GET 模型列表端点——既验证 baseUrl 可达性，又发现服务器真实型号，
// 消除首次上手「型号名靠猜」的摩擦。错误一律 ASCII 错误码（DW_PROBE_*），
// 渲染端经 localizeError 按当前语言本地化。
// ============================================================================

export interface ProbeProviderOptions {
  type: ProviderType;
  baseUrl: string;
  /** 已解析的密钥（调用方负责凭证逻辑）；缺省不发任何鉴权头。 */
  apiKey?: string;
  /** 默认 5000ms；超时抛 DW_PROBE_TIMEOUT。 */
  timeoutMs?: number;
}

export interface ProbeProviderSuccess {
  ok: true;
  /** 服务器返回的型号清单（响应无 data 数组时为空数组，仍算可达）。 */
  models: string[];
}

const DEFAULT_TIMEOUT_MS = 5_000;
// 与 anthropic.ts 保持一致（同包单一事实源）
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * 探测 provider 可达性：
 * - openai 兼容：GET {baseUrl}/models（baseUrl 已含 /v1，Ollama 同样响应此端点）；
 * - anthropic：GET {baseUrl}/v1/models（baseUrl 为 host 根，与 /v1/messages 同构）。
 * 非 2xx 抛 DW_PROBE_HTTP:<status>；连接失败抛 DW_PROBE_UNREACHABLE；
 * 超时抛 DW_PROBE_TIMEOUT；baseUrl 非法抛 DW_PROBE_INVALID_URL。
 * 测试可注入 fetch 替身（构造 Response 对象，非网络 mock）。
 */
export async function probeProvider(
  options: ProbeProviderOptions,
  fetchImpl: typeof fetch = fetch
): Promise<ProbeProviderSuccess> {
  const baseUrl = options.baseUrl.trim();
  if (baseUrl === "") throw new Error("DW_PROBE_INVALID_URL:empty");
  let url: URL;
  try {
    url = new URL(joinUrl(baseUrl, options.type === "anthropic" ? "/v1/models" : "/models"));
  } catch {
    throw new Error(`DW_PROBE_INVALID_URL:${baseUrl}`);
  }
  const headers: Record<string, string> =
    options.type === "anthropic"
      ? {
          ...(options.apiKey !== undefined ? { "x-api-key": options.apiKey } : {}),
          "anthropic-version": ANTHROPIC_VERSION,
        }
      : options.apiKey !== undefined
        ? { authorization: `Bearer ${options.apiKey}` }
        : {};

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "GET", headers, signal: controller.signal });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`DW_PROBE_TIMEOUT:${String(timeoutMs)}`);
    }
    // fetch 网络层失败（ECONNREFUSED/DNS/TLS）在 Node 与浏览器均表现为 TypeError
    throw new Error("DW_PROBE_UNREACHABLE");
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`DW_PROBE_HTTP:${String(response.status)}`);
  }
  const body = safeParseJson(await response.text());
  const models: string[] = [];
  if (isRecord(body) && Array.isArray(body["data"])) {
    for (const entry of body["data"]) {
      if (!isRecord(entry)) continue;
      const id = asString(entry["id"]);
      if (id !== undefined && id !== "") models.push(id);
    }
  }
  return { ok: true, models };
}
