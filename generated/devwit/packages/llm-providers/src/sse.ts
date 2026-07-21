/**
 * SSE（Server-Sent Events）解析器。
 *
 * 逐 `data:` 行产出 payload 字符串：
 * - 跨 chunk 切断的行先缓冲，遇到换行符再产出；
 * - 同时兼容 `\n` 与 `\r\n` 行尾；
 * - 空行（事件分隔符）、`:` 开头的注释行、`event:`/`id:`/`retry:` 字段行被跳过；
 * - 收到 `[DONE]`（OpenAI 流的终止哨兵）时结束迭代且不再产出；
 * - 流末尾无换行收尾的残余缓冲也会被冲刷产出。
 */
export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        const payload = extractDataPayload(line);
        if (payload === undefined) continue;
        if (payload === "[DONE]") return;
        yield payload;
      }
    }
    // 冲刷解码器与缓冲区中最后一行（无换行结尾）
    buffer += decoder.decode();
    if (buffer.length > 0) {
      let line = buffer;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const payload = extractDataPayload(line);
      if (payload !== undefined && payload !== "[DONE]") yield payload;
    }
  } finally {
    reader.releaseLock();
  }
}

function extractDataPayload(line: string): string | undefined {
  if (line.length === 0) return undefined;
  if (line.startsWith(":")) return undefined;
  if (!line.startsWith("data:")) return undefined;
  let payload = line.slice("data:".length);
  if (payload.startsWith(" ")) payload = payload.slice(1);
  return payload;
}
