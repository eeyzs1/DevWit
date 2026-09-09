import { ProviderHttpError } from "@devwit/contracts";

/**
 * 统一的 HTTP 状态检查：非 2xx 抛 ProviderHttpError。
 * retryable 规则：429（限流）或 5xx（服务端故障）可重试，其余不可。
 * Retry-After（秒）转毫秒随错误携带（上限 60s，防服务端荒谬值拖死会话）。
 * 测试可直接构造 Response 对象喂给本函数（依赖注入式测试替身，非网络 mock）。
 */
export async function assertResponseOk(response: Response): Promise<void> {
  if (response.ok) return;
  const body = await response.text().catch(() => "");
  const retryable = response.status === 429 || response.status >= 500;
  let retryAfterMs: number | undefined;
  if (retryable) {
    const header = response.headers.get("retry-after");
    if (header !== null) {
      const seconds = Number(header);
      if (Number.isFinite(seconds) && seconds > 0) {
        retryAfterMs = Math.min(seconds, 60) * 1000;
      }
    }
  }
  throw new ProviderHttpError(response.status, body, retryable, retryAfterMs);
}

/** 拼接 baseUrl 与路径，容忍 baseUrl 末尾的斜杠。 */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/** 连接阶段（发起到响应头到达）缺省超时：服务器 hang 不再永久挂起会话与 RAG 队列。 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/**
 * 带连接阶段超时的 fetch（🟡修复：streamChat/embed 原先完全无超时）。
 * - 仅对「发起 → 响应头」限时；头部到达即清除计时——流式体不受总时长约束
 *   （长回复/长思考是合法流），之后仅由调用方 signal 治理（取消即刻传播）。
 * - 超时抛 DOMException("connection timeout")，与调用方 abort 一致地向上冒泡。
 */
export async function fetchWithConnectTimeout(
  url: string,
  init: RequestInit,
  connectTimeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS
): Promise<Response> {
  const callerSignal = init.signal;
  const controller = new AbortController();
  const onCallerAbort = (): void => {
    controller.abort(callerSignal?.reason);
  };
  if (callerSignal !== undefined && callerSignal !== null) {
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason);
    } else {
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }
  const timer = setTimeout(
    () => controller.abort(new DOMException("connection timeout", "TimeoutError")),
    connectTimeoutMs
  );
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    // 仅清除连接超时计时；调用方 signal → controller 的传播监听器保留到流结束——
    // {once:true} 触发即自动解绑，未触发则随 signal 生命周期回收（响应头到达后
    // 调用方 abort 仍必须即刻中断 body 读取，见 http-timeout.test.ts 回归）。
    clearTimeout(timer);
  }
}

/** 预流阶段缺省重试次数（429/5xx/连接超时）。 */
export const DEFAULT_STREAM_RETRIES = 2;

function isRetryableError(error: unknown): error is ProviderHttpError {
  if (error instanceof ProviderHttpError) return error.retryable;
  // 连接阶段超时（fetchWithConnectTimeout 的 TimeoutError）视为瞬时故障可重试；
  // 调用方主动取消（AbortError）绝不重试
  return error instanceof DOMException && error.name === "TimeoutError";
}

/** 退避等待：可被调用方 signal 提前打断（打断即抛 AbortError，不再重试）。 */
function backoffSleep(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 预流重试 fetch（🟡修复：retryable 此前只标注、无任何消费方——429 直接失败给用户）。
 *
 * 仅重试「fetch + 状态检查」阶段：此阶段尚未产出任何流事件，重试不会造成
 * 部分输出重复；一旦返回（进入流解析）则绝不重试。
 * - 429/5xx：优先尊重 Retry-After（毫秒，assertResponseOk 已解析并封顶 60s）；
 * - 连接超时：指数退避 500ms → 1s → 2s；
 * - 调用方 abort（用户取消）：立即冒泡，不重试。
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: { connectTimeoutMs?: number; retries?: number } = {}
): Promise<Response> {
  const retries = options.retries ?? DEFAULT_STREAM_RETRIES;
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetchWithConnectTimeout(url, init, options.connectTimeoutMs);
      await assertResponseOk(response);
      return response;
    } catch (error) {
      if (!isRetryableError(error) || attempt >= retries) throw error;
      const retryAfter = error instanceof ProviderHttpError ? error.retryAfterMs : undefined;
      const backoff = retryAfter ?? 500 * 2 ** attempt;
      await backoffSleep(backoff, init.signal);
    }
  }
}
