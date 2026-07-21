import { ProviderHttpError } from "@devwit/contracts";

/**
 * 统一的 HTTP 状态检查：非 2xx 抛 ProviderHttpError。
 * retryable 规则：429（限流）或 5xx（服务端故障）可重试，其余不可。
 * 测试可直接构造 Response 对象喂给本函数（依赖注入式测试替身，非网络 mock）。
 */
export async function assertResponseOk(response: Response): Promise<void> {
  if (response.ok) return;
  const body = await response.text().catch(() => "");
  throw new ProviderHttpError(response.status, body, response.status === 429 || response.status >= 500);
}

/** 拼接 baseUrl 与路径，容忍 baseUrl 末尾的斜杠。 */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}
