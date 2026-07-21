import { ProviderHttpError, type ChatMessage, type ProviderConfig, type StreamEvent, type ToolDefinition } from "@devwit/contracts";
import { describe, expect, it } from "vitest";
import {
  buildAnthropicRequest,
  parseAnthropicEvents,
  toAnthropicMessages,
  type AnthropicToolResultBlock,
  type AnthropicToolUseBlock,
} from "../src/anthropic.js";
import { assertResponseOk } from "../src/http.js";
import { parseSseStream } from "../src/sse.js";
import { collect, readFixture, streamFromChunks } from "./helpers.js";

const config: ProviderConfig = {
  id: "claude",
  type: "anthropic",
  label: "Claude",
  baseUrl: "https://example.invalid",
  model: "claude-sonnet-4-20250514",
  credentialRef: "cred-claude",
  maxTokens: 1024,
};

const tools: ToolDefinition[] = [
  {
    name: "write",
    description: "写文件",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];

describe("toAnthropicMessages（请求映射）", () => {
  it("提取 system 消息为顶层参数，多条以空行连接", () => {
    const { system, messages } = toAnthropicMessages([
      { role: "system", content: "你是助手。" },
      { role: "system", content: "保持简洁。" },
      { role: "user", content: "你好" },
    ]);
    expect(system).toBe("你是助手。\n\n保持简洁。");
    expect(messages).toEqual([{ role: "user", content: "你好" }]);
  });

  it("assistant toolCalls 映射为 tool_use 块，tool 结果映射为 tool_result 并合并进一条 user 消息", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "创建文件" },
      {
        role: "assistant",
        content: "好的",
        toolCalls: [{ id: "toolu_1", name: "write", args: { path: "a.txt", content: "x" } }],
      },
      { role: "tool", toolCallId: "toolu_1", content: "已写入" },
      { role: "tool", toolCallId: "toolu_2", content: "第二个结果" },
    ];
    const { messages } = toAnthropicMessages(history);
    expect(messages).toHaveLength(3);
    const assistant = messages[1];
    expect(assistant?.role).toBe("assistant");
    const blocks = assistant?.content;
    expect(Array.isArray(blocks)).toBe(true);
    if (Array.isArray(blocks)) {
      expect(blocks[0]).toEqual({ type: "text", text: "好的" });
      const toolUse = blocks[1] as AnthropicToolUseBlock;
      expect(toolUse.type).toBe("tool_use");
      expect(toolUse.id).toBe("toolu_1");
      expect(toolUse.input).toEqual({ path: "a.txt", content: "x" });
    }
    // 两个连续 tool 结果合并进同一条 user 消息
    const user = messages[2];
    expect(user?.role).toBe("user");
    if (user && Array.isArray(user.content)) {
      const results = user.content.filter((b): b is AnthropicToolResultBlock => b.type === "tool_result");
      expect(results).toHaveLength(2);
      expect(results[0]?.tool_use_id).toBe("toolu_1");
      expect(results[1]?.content).toBe("第二个结果");
    } else {
      expect.unreachable("tool 结果应映射为 content blocks");
    }
  });
});

describe("buildAnthropicRequest", () => {
  it("tools 映射为 input_schema，附带 model/max_tokens/stream", () => {
    const body = buildAnthropicRequest(config, [{ role: "user", content: "hi" }], tools);
    expect(body.model).toBe("claude-sonnet-4-20250514");
    expect(body.max_tokens).toBe(1024);
    expect(body.stream).toBe(true);
    expect(body.tools).toEqual([
      {
        name: "write",
        description: "写文件",
        input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    ]);
    expect(body.system).toBeUndefined();
  });

  it("tools 为空时不携带 tools 字段", () => {
    const body = buildAnthropicRequest(config, [{ role: "user", content: "hi" }], []);
    expect("tools" in body).toBe(false);
  });
});

describe("parseAnthropicEvents（fixture 回放）", () => {
  it("文本增量、tool_use 参数分片累积、usage、done(tool_use) 全部正确", async () => {
    const events = await collect(parseAnthropicEvents(parseSseStream(streamFromChunks([readFixture("anthropic-stream.txt")]))));
    const types = events.map((e) => e.type);

    const text = events
      .filter((e): e is Extract<StreamEvent, { type: "text" }> => e.type === "text")
      .map((e) => e.text)
      .join("");
    expect(text).toBe("好的，我来帮你查天气。");

    const toolCall = events.find((e): e is Extract<StreamEvent, { type: "tool_call" }> => e.type === "tool_call");
    expect(toolCall?.toolCall).toEqual({
      id: "toolu_01A09q90qw90lq917835lq9",
      name: "get_weather",
      args: { location: "San Francisco, CA" },
    });

    const usage = events.find((e): e is Extract<StreamEvent, { type: "usage" }> => e.type === "usage");
    expect(usage).toEqual({ type: "usage", inputTokens: 25, outputTokens: 40 });

    const done = events[events.length - 1];
    expect(done).toEqual({ type: "done", stopReason: "tool_use" });
    // 顺序：text* → tool_call → usage → done
    expect(types.indexOf("tool_call")).toBeGreaterThan(types.lastIndexOf("text"));
    expect(types.indexOf("usage")).toBeGreaterThan(types.indexOf("tool_call"));
  });

  it("非法 JSON payload 产出 error 事件而不中断流", async () => {
    const payloads = (async function* (): AsyncGenerator<string> {
      yield "not-json{{{";
      yield '{"type":"message_stop"}';
    })();
    const events = await collect(parseAnthropicEvents(payloads));
    expect(events[0]?.type).toBe("error");
    expect(events[events.length - 1]).toEqual({ type: "done", stopReason: "end_turn" });
  });
});

describe("错误路径（构造 Response 直接喂解析函数）", () => {
  it("429 → ProviderHttpError 且 retryable=true", async () => {
    const response = new Response("rate limited", { status: 429, statusText: "Too Many Requests" });
    try {
      await assertResponseOk(response);
      expect.unreachable("应抛出 ProviderHttpError");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderHttpError);
      expect((error as ProviderHttpError).status).toBe(429);
      expect((error as ProviderHttpError).retryable).toBe(true);
    }
  });

  it("400 → retryable=false；2xx 不抛错", async () => {
    const bad = new Response("bad request", { status: 400 });
    await expect(assertResponseOk(bad)).rejects.toMatchObject({ status: 400, retryable: false });
    await expect(assertResponseOk(new Response("ok", { status: 200 }))).resolves.toBeUndefined();
  });
});
