import type {
  ChatMessage,
  CredentialResolver,
  LLMProvider,
  ProviderConfig,
  StreamEvent,
  ToolDefinition,
  ToolParameterSchema,
} from "@devwit/contracts";
import { asNumber, asString, isRecord, parseJsonObject, safeParseJson } from "./guards.js";
import { assertResponseOk, joinUrl } from "./http.js";
import { parseSseStream } from "./sse.js";

// ============================================================================
// 请求侧类型（OpenAI 兼容 chat/completions 的真实请求形状）
// ============================================================================

export interface OpenAiFunctionToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type OpenAiMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAiFunctionToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface OpenAiToolParam {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: ToolParameterSchema;
  };
}

export interface OpenAiRequestBody {
  model: string;
  messages: OpenAiMessage[];
  tools?: OpenAiToolParam[];
  stream: true;
  max_tokens: number;
  stream_options: { include_usage: boolean };
  temperature?: number;
}

type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "cancelled";

/**
 * 统一消息 → OpenAI chat/completions 参数映射：
 * - assistant 的 toolCalls 映射为 tool_calls（arguments 为 JSON 字符串）；
 * - role=tool 的结果映射为 role:"tool" + tool_call_id。
 */
export function toOpenAiMessages(messages: ChatMessage[]): OpenAiMessage[] {
  return messages.map((message): OpenAiMessage => {
    if (message.role === "assistant") {
      const toolCalls = message.toolCalls;
      return {
        role: "assistant",
        content: message.content.length > 0 ? message.content : null,
        ...(toolCalls && toolCalls.length > 0
          ? {
              tool_calls: toolCalls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              })),
            }
          : {}),
      };
    }
    if (message.role === "tool") {
      return { role: "tool", tool_call_id: message.toolCallId ?? "", content: message.content };
    }
    return { role: message.role, content: message.content };
  });
}

export function buildOpenAiRequest(config: ProviderConfig, messages: ChatMessage[], tools: ToolDefinition[]): OpenAiRequestBody {
  return {
    model: config.model,
    messages: toOpenAiMessages(messages),
    ...(tools.length > 0
      ? {
          tools: tools.map((tool) => ({
            type: "function" as const,
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
          })),
        }
      : {}),
    stream: true,
    max_tokens: config.maxTokens,
    stream_options: { include_usage: true },
    ...(typeof config.temperature === "number" ? { temperature: config.temperature } : {}),
  };
}

// ============================================================================
// 响应侧：SSE payload → 统一 StreamEvent
// ============================================================================

interface PendingToolCall {
  id: string;
  name: string;
  argsJson: string;
}

/**
 * 解析 OpenAI 流式 chat.completion.chunk 序列：
 * - delta.content 直接产出 text 事件；
 * - delta.tool_calls 按 index 分桶累积（id/name 首帧到达，arguments 分片追加），
 *   在 finish_reason 到达（或流结束兜底）时按 index 顺序产出完整 tool_call；
 * - usage 由 stream_options.include_usage 的末尾统计帧产出；
 * - [DONE] 哨兵已被 parseSseStream 消费，不会到达这里。
 */
export async function* parseOpenAiEvents(payloads: AsyncIterable<string>): AsyncGenerator<StreamEvent> {
  const pending = new Map<number, PendingToolCall>();
  let finishReason: StopReason | undefined;
  let flushed = false;

  for await (const payload of payloads) {
    const chunk = parseJsonObject(payload);
    if (!chunk) {
      // 错误码保持 ASCII：消息经 trace→IPC 到渲染端，localizeError 按当前语言本地化
      yield { type: "error", error: "DW_SSE_PARSE_FAILED:openai", retryable: false };
      continue;
    }
    const usage = chunk["usage"];
    if (isRecord(usage)) {
      const inputTokens = asNumber(usage["prompt_tokens"]);
      const outputTokens = asNumber(usage["completion_tokens"]);
      if (inputTokens !== undefined || outputTokens !== undefined) {
        yield { type: "usage", inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 };
      }
    }
    const choices = chunk["choices"];
    if (!Array.isArray(choices)) continue;
    const choice: unknown = choices[0];
    if (!isRecord(choice)) continue;
    const delta = choice["delta"];
    if (isRecord(delta)) {
      const content = asString(delta["content"]);
      if (content) yield { type: "text", text: content };
      const toolCalls = delta["tool_calls"];
      if (Array.isArray(toolCalls)) {
        for (const entry of toolCalls) {
          if (!isRecord(entry)) continue;
          const index = asNumber(entry["index"]) ?? 0;
          const state = pending.get(index) ?? { id: "", name: "", argsJson: "" };
          const id = asString(entry["id"]);
          if (id) state.id = id;
          const fn = entry["function"];
          if (isRecord(fn)) {
            const name = asString(fn["name"]);
            if (name) state.name = name;
            const argsChunk = asString(fn["arguments"]);
            if (argsChunk) state.argsJson += argsChunk;
          }
          pending.set(index, state);
        }
      }
    }
    const reason = asString(choice["finish_reason"]);
    if (reason) {
      finishReason = mapFinishReason(reason);
      if (!flushed && pending.size > 0) {
        flushed = true;
        for (const state of sortedPending(pending)) {
          yield { type: "tool_call", toolCall: { id: state.id, name: state.name, args: parseToolArgs(state.argsJson) } };
        }
      }
    }
  }

  if (!flushed) {
    for (const state of sortedPending(pending)) {
      yield { type: "tool_call", toolCall: { id: state.id, name: state.name, args: parseToolArgs(state.argsJson) } };
    }
  }
  yield { type: "done", stopReason: finishReason ?? "end_turn" };
}

function sortedPending(pending: Map<number, PendingToolCall>): PendingToolCall[] {
  return [...pending.keys()]
    .sort((a, b) => a - b)
    .map((index) => pending.get(index))
    .filter((state): state is PendingToolCall => state !== undefined);
}

function mapFinishReason(reason: string): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return "end_turn";
  }
}

function parseToolArgs(json: string): Record<string, unknown> {
  if (json.length === 0) return {};
  const value = safeParseJson(json);
  return isRecord(value) ? value : {};
}

// ============================================================================
// Provider 实现
// ============================================================================

export class OpenAiCompatibleProvider implements LLMProvider {
  readonly config: ProviderConfig;
  private readonly credentials: CredentialResolver;

  constructor(config: ProviderConfig, credentials: CredentialResolver) {
    this.config = config;
    this.credentials = credentials;
  }

  async *streamChat(messages: ChatMessage[], tools: ToolDefinition[], signal?: AbortSignal): AsyncIterable<StreamEvent> {
    if (!this.config.baseUrl) throw new Error("OpenAiCompatibleProvider: ProviderConfig.baseUrl is empty");
    const apiKey = await this.credentials.resolve(this.config.credentialRef);
    const body = buildOpenAiRequest(this.config, messages, tools);
    const response = await fetch(joinUrl(this.config.baseUrl, "/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    await assertResponseOk(response);
    if (!response.body) throw new Error("OpenAiCompatibleProvider: response has no readable body stream");
    yield* parseOpenAiEvents(parseSseStream(response.body));
  }
}
