/**
 * 解析 LLM API 的 JSON 数据时的类型收窄工具。
 * 所有线上响应一律按 unknown 处理，经这里的守卫收窄（禁止 any）。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** JSON.parse 的安全版本：解析失败返回 undefined 而不是抛异常。 */
export function safeParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** 将 JSON.parse 的结果收窄为 Record；非对象（含数组/null/原始值）返回 undefined。 */
export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const value = safeParseJson(text);
  return isRecord(value) ? value : undefined;
}
