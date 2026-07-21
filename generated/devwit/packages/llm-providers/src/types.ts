import type { CredentialResolver, LLMProvider, ProviderConfig } from "@devwit/contracts";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAiCompatibleProvider } from "./openai.js";

/** Provider 工厂签名：按配置与凭证解析器构造一个 LLMProvider 实例。 */
export type ProviderFactory = (config: ProviderConfig, credentials: CredentialResolver) => LLMProvider;

/** 默认工厂：按 config.type 分发到 Anthropic / OpenAI 兼容实现。 */
export const createProvider: ProviderFactory = (config, credentials) => {
  switch (config.type) {
    case "anthropic":
      return new AnthropicProvider(config, credentials);
    case "openai":
      return new OpenAiCompatibleProvider(config, credentials);
    default:
      throw new Error(`不支持的 provider 类型: ${String((config as ProviderConfig).type)}`);
  }
};
