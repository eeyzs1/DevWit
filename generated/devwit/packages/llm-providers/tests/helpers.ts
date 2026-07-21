import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 读取 tests/fixtures 下的 SSE 录制 fixture（真实协议帧格式，见文件头注释）。 */
export function readFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf-8");
}

/** 把字符串块序列包装成 ReadableStream，模拟网络分块到达。 */
export function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/** 按固定长度切分字符串，用于构造"跨 chunk 切断"的流。 */
export function splitEvery(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}
