import { ProviderHttpError, type ChatMessage, type ProviderConfig, type StreamEvent, type ToolDefinition } from "@devwit/contracts";
import { describe, expect, it } from "vitest";
import { assertResponseOk } from "../src/http.js";
import { buildOpenAiRequest, parseOpenAiEvents, toOpenAiMessages } from "../src/openai.js";
import { parseSseStream } from "../src/sse.js";
import { collect, readFixture, streamFromChunks } from "./helpers.js";

const config: ProviderConfig = {
  id: "gpt",
  type: "openai",
  label: "GPT",
  baseUrl: "https://example.invalid/v1",
  model: "gpt-4o-2024-08-06",
  credentialRef: "cred-gpt",
  maxTokens: 2048,
  temperature: 0.2,
};

const tools: ToolDefinition[] = [
  {
    name: "write",
    description: "写文件",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  },
];

describe("toOpenAiMessages（请求映射）", () => {
  it("assistant toolCalls → tool_calls（arguments 为 JSON 字符串）；tool → role:tool + tool_call_id", () => {
    const history: ChatMessage[] = [
      { role: "system", content: "你是助手。" },
      { role: "user", content: "创建文件" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "write", args: { path: "a.txt", content: "x" } }],
      },
      { role: "tool", toolCallId: "call_1", content: "已写入" },
    ];
    const mapped = toOpenAiMessages(history);
    expect(mapped[0]).toEqual({ role: "system", content: "你是助手。" });
    expect(mapped[2]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "write", arguments: '{"path":"a.txt","content":"x"}' },
        },
      ],
    });
    expect(mapped[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "已写入" });
  });
});

describe("buildOpenAiRequest", () => {
  it("tools 包装为 function 形式，附带 stream_options.include_usage 与 temperature", () => {
    const body = buildOpenAiRequest(config, [{ role: "user", content: "hi" }], tools);
    expect(body.model).toBe("gpt-4o-2024-08-06");
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(2048);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.temperature).toBe(0.2);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "write",
          description: "写文件",
          parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
        },
      },
    ]);
  });
});

describe("parseOpenAiEvents（fixture 回放）", () => {
  it("content 增量、tool_calls 分片累积、usage 统计帧、done(tool_use) 全部正确", async () => {
    const events = await collect(parseOpenAiEvents(parseSseStream(streamFromChunks([readFixture("openai-stream.txt")]))));
    const types = events.map((e) => e.type);

    const text = events
      .filter((e): e is Extract<StreamEvent, { type: "text" }> => e.type === "text")
      .map((e) => e.text)
      .join("");
    expect(text).toBe("好的，我来创建文件。");

    const toolCall = events.find((e): e is Extract<StreamEvent, { type: "tool_call" }> => e.type === "tool_call");
    expect(toolCall?.toolCall).toEqual({
      id: "call_abc123xyz",
      name: "write",
      args: { path: "hello.js", content: "console.log(1)" },
    });

    const usage = events.find((e): e is Extract<StreamEvent, { type: "usage" }> => e.type === "usage");
    expect(usage).toEqual({ type: "usage", inputTokens: 82, outputTokens: 21 });

    expect(events[events.length - 1]).toEqual({ type: "done", stopReason: "tool_use" });
    // 顺序：text* → tool_call → usage → done
    expect(types.indexOf("tool_call")).toBeGreaterThan(types.lastIndexOf("text"));
    expect(types.indexOf("usage")).toBeGreaterThan(types.indexOf("tool_call"));
  });

  it("finish_reason=stop 时 done(end_turn)，无 tool_calls", async () => {
    const text = [
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"你好"},"finish_reason":null}]}',
      "",
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const events = await collect(parseOpenAiEvents(parseSseStream(streamFromChunks([text]))));
    expect(events).toEqual([
      { type: "text", text: "你好" },
      { type: "done", stopReason: "end_turn" },
    ]);
  });
});

describe("错误路径（构造 Response 直接喂解析函数）", () => {
  it("500 → ProviderHttpError 且 retryable=true；401 → retryable=false", async () => {
    const serverError = new Response("internal error", { status: 500 });
    try {
      await assertResponseOk(serverError);
      expect.unreachable("应抛出 ProviderHttpError");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderHttpError);
      expect((error as ProviderHttpError).retryable).toBe(true);
    }
    const unauthorized = new Response("unauthorized", { status: 401 });
    await expect(assertResponseOk(unauthorized)).rejects.toMatchObject({ status: 401, retryable: false });
  });
});
