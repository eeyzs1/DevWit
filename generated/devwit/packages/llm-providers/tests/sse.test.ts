import { describe, expect, it } from "vitest";
import { parseSseStream } from "../src/sse.js";
import { collect, readFixture, splitEvery, streamFromChunks } from "./helpers.js";

describe("parseSseStream", () => {
  it("逐 data: 行产出 payload，跳过 event:/注释/空行", async () => {
    const payloads = await collect(parseSseStream(streamFromChunks([readFixture("anthropic-stream.txt")])));
    expect(payloads.length).toBeGreaterThan(0);
    // 每条 payload 都是合法 JSON 且不带 event:/注释行
    for (const payload of payloads) {
      expect(payload.startsWith("event:")).toBe(false);
      expect(payload.startsWith(":")).toBe(false);
      expect(() => JSON.parse(payload)).not.toThrow();
    }
    const first = JSON.parse(payloads[0] ?? "") as { type?: string };
    expect(first.type).toBe("message_start");
  });

  it("跨 chunk 切断的行被正确拼接（与单 chunk 结果一致）", async () => {
    const fixture = readFixture("anthropic-stream.txt");
    const single = await collect(parseSseStream(streamFromChunks([fixture])));
    // 用 7 字节小块切断整个流（必然切在行中间）
    const fragmented = await collect(parseSseStream(streamFromChunks(splitEvery(fixture, 7))));
    expect(fragmented).toEqual(single);
  });

  it("OpenAI fixture 在 [DONE] 处终止且不产出 [DONE] 本身", async () => {
    const payloads = await collect(parseSseStream(streamFromChunks([readFixture("openai-stream.txt")])));
    expect(payloads).not.toContain("[DONE]");
    const last = JSON.parse(payloads[payloads.length - 1] ?? "") as { usage?: { total_tokens?: number } };
    expect(last.usage?.total_tokens).toBe(103);
  });

  it("[DONE] 之后的数据不再产出", async () => {
    const text = "data: one\n\ndata: [DONE]\ndata: two\n";
    const payloads = await collect(parseSseStream(streamFromChunks([text])));
    expect(payloads).toEqual(["one"]);
  });

  it("兼容 \\r\\n 行尾与无空格 data: 前缀", async () => {
    const text = "data:{\"a\":1}\r\n\r\ndata: {\"b\":2}\r\n";
    const payloads = await collect(parseSseStream(streamFromChunks([text])));
    expect(payloads).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("流末尾无换行的残余行也会被冲刷产出", async () => {
    const payloads = await collect(parseSseStream(streamFromChunks(["data: tail-no-newline"])));
    expect(payloads).toEqual(["tail-no-newline"]);
  });
});
