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
// 请求侧类型（Anthropic Messages API 的真实请求形状）
// ============================================================================

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

export type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

export interface AnthropicMessageParam {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicToolParam {
  name: string;
  description: string;
  input_schema: ToolParameterSchema;
}

export interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessageParam[];
  tools?: AnthropicToolParam[];
  stream: true;
  temperature?: number;
}

const ANTHROPIC_VERSION = "2023-06-01";

type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "cancelled";

/**
 * 统一消息 → Anthropic Messages API 参数映射：
 * - role=system 的消息提取为顶层 system 参数（多条以空行连接）；
 * - role=assistant 的 toolCalls 映射为 tool_use content block；
 * - role=tool 的结果映射为 tool_result block，且必须落在 user 消息里——
 *   连续的 tool 结果合并进同一条 user 消息（Anthropic 要求 user/assistant 交替）。
 */
export function toAnthropicMessages(messages: ChatMessage[]): { system?: string; messages: AnthropicMessageParam[] } {
  const systemParts: string[] = [];
  const out: AnthropicMessageParam[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      if (message.content) systemParts.push(message.content);
      continue;
    }
    if (message.role === "assistant") {
      const blocks: AnthropicContentBlock[] = [];
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.args });
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }
    if (message.role === "tool") {
      const block: AnthropicToolResultBlock = {
        type: "tool_result",
        tool_use_id: message.toolCallId ?? "",
        content: message.content,
      };
      const prev = out[out.length - 1];
      if (prev && prev.role === "user") {
        if (typeof prev.content === "string") {
          prev.content = [
            { type: "text", text: prev.content },
            block,
          ];
        } else {
          prev.content.push(block);
        }
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }
    out.push({ role: "user", content: message.content });
  }
  return { ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}), messages: out };
}

export function buildAnthropicRequest(
  config: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolDefinition[]
): AnthropicRequestBody {
  const { system, messages: anthropicMessages } = toAnthropicMessages(messages);
  return {
    model: config.model,
    max_tokens: config.maxTokens,
    ...(system !== undefined ? { system } : {}),
    messages: anthropicMessages,
    ...(tools.length > 0
      ? {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
          })),
        }
      : {}),
    stream: true,
    ...(typeof config.temperature === "number" ? { temperature: config.temperature } : {}),
  };
}

// ============================================================================
// 响应侧：SSE payload → 统一 StreamEvent
// ============================================================================

interface PendingToolUse {
  id: string;
  name: string;
  argsJson: string;
}

/**
 * 解析 Anthropic 流式事件序列（message_start / content_block_* / message_delta / message_stop）。
 * tool_use 的 input 由若干 input_json_delta 分片累积成完整 JSON，在 content_block_stop 时
 * 产出统一的 tool_call 事件（id 使用 Anthropic 的 tool_use id）。
 */
export async function* parseAnthropicEvents(payloads: AsyncIterable<string>): AsyncGenerator<StreamEvent> {
  const pendingBlocks = new Map<number, PendingToolUse>();
  let inputTokens = 0;
  let stopReason: StopReason = "end_turn";
  for await (const payload of payloads) {
    const event = parseJsonObject(payload);
    if (!event) {
      yield { type: "error", error: `无法解析 Anthropic SSE 数据: ${payload.slice(0, 120)}`, retryable: false };
      continue;
    }
    const eventType = asString(event["type"]);
    switch (eventType) {
      case "message_start": {
        const message = event["message"];
        if (isRecord(message) && isRecord(message["usage"])) {
          inputTokens = asNumber(message["usage"]["input_tokens"]) ?? 0;
        }
        break;
      }
      case "content_block_start": {
        const index = asNumber(event["index"]);
        const block = event["content_block"];
        if (index !== undefined && isRecord(block) && block["type"] === "tool_use") {
          pendingBlocks.set(index, {
            id: asString(block["id"]) ?? "",
            name: asString(block["name"]) ?? "",
            argsJson: "",
          });
        }
        break;
      }
      case "content_block_delta": {
        const index = asNumber(event["index"]);
        const delta = event["delta"];
        if (!isRecord(delta)) break;
        const deltaType = asString(delta["type"]);
        if (deltaType === "text_delta") {
          const text = asString(delta["text"]);
          if (text) yield { type: "text", text };
        } else if (deltaType === "input_json_delta" && index !== undefined) {
          const state = pendingBlocks.get(index);
          const partial = asString(delta["partial_json"]);
          if (state && partial) state.argsJson += partial;
        }
        break;
      }
      case "content_block_stop": {
        const index = asNumber(event["index"]);
        if (index === undefined) break;
        const state = pendingBlocks.get(index);
        if (state) {
          pendingBlocks.delete(index);
          yield { type: "tool_call", toolCall: { id: state.id, name: state.name, args: parseToolArgs(state.argsJson) } };
        }
        break;
      }
      case "message_delta": {
        const delta = event["delta"];
        if (isRecord(delta)) {
          const reason = asString(delta["stop_reason"]);
          if (reason === "end_turn" || reason === "tool_use" || reason === "max_tokens" || reason === "stop_sequence") {
            stopReason = reason;
          }
        }
        const usage = event["usage"];
        if (isRecord(usage)) {
          const outputTokens = asNumber(usage["output_tokens"]);
          if (outputTokens !== undefined) yield { type: "usage", inputTokens, outputTokens };
        }
        break;
      }
      case "message_stop": {
        yield { type: "done", stopReason };
        return;
      }
      case "error": {
        const error = event["error"];
        const message = isRecord(error) ? asString(error["message"]) ?? "未知 Anthropic 错误" : "未知 Anthropic 错误";
        yield { type: "error", error: message, retryable: false };
        break;
      }
      default:
        break; // ping 等保活事件忽略
    }
  }
  // 流被截断的兜底：冲刷未闭合的 tool_use 块，并给出终止事件
  for (const state of pendingBlocks.values()) {
    yield { type: "tool_call", toolCall: { id: state.id, name: state.name, args: parseToolArgs(state.argsJson) } };
  }
  yield { type: "done", stopReason };
}

function parseToolArgs(json: string): Record<string, unknown> {
  if (json.length === 0) return {};
  const value = safeParseJson(json);
  return isRecord(value) ? value : {};
}

// ============================================================================
// Provider 实现
// ============================================================================

export class AnthropicProvider implements LLMProvider {
  readonly config: ProviderConfig;
  private readonly credentials: CredentialResolver;

  constructor(config: ProviderConfig, credentials: CredentialResolver) {
    this.config = config;
    this.credentials = credentials;
  }

  async *streamChat(messages: ChatMessage[], tools: ToolDefinition[], signal?: AbortSignal): AsyncIterable<StreamEvent> {
    if (!this.config.baseUrl) throw new Error("AnthropicProvider: ProviderConfig.baseUrl 为空");
    const apiKey = await this.credentials.resolve(this.config.credentialRef);
    const body = buildAnthropicRequest(this.config, messages, tools);
    const response = await fetch(joinUrl(this.config.baseUrl, "/v1/messages"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    await assertResponseOk(response);
    if (!response.body) throw new Error("AnthropicProvider: 响应缺少可读取的 body 流");
    yield* parseAnthropicEvents(parseSseStream(response.body));
  }
}
