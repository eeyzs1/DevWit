import type { CredentialResolver, LLMProvider, ProviderConfig } from "@devwit/contracts";
import { createProvider } from "./types.js";

/**
 * ProviderRegistry：provider 配置的内存注册表。
 * - 配置由 settings/apps 层经 register/upsert 注入（credentialRef 只存引用，AR005）；
 * - createProvider(id) 按类型分发到具体实现，并注入全局 CredentialResolver——
 *   密钥在每次真实请求时才读取，换 key 无需重启（热更新）；
 * - onDidChange 事件供 UI/运行时感知配置变更。
 */
export class ProviderRegistry {
  private readonly configs = new Map<string, ProviderConfig>();
  private readonly listeners = new Set<() => void>();
  private readonly credentials: CredentialResolver;

  constructor(credentials: CredentialResolver) {
    this.credentials = credentials;
  }

  register(config: ProviderConfig): void {
    validateProviderConfig(config);
    this.configs.set(config.id, { ...config });
    this.emitChange();
  }

  remove(id: string): boolean {
    const removed = this.configs.delete(id);
    if (removed) this.emitChange();
    return removed;
  }

  get(id: string): ProviderConfig | undefined {
    const config = this.configs.get(id);
    return config ? { ...config } : undefined;
  }

  list(): ProviderConfig[] {
    return [...this.configs.values()].map((config) => ({ ...config }));
  }

  /** 按 id 查找配置并按类型分发到 Anthropic / OpenAI 兼容实现。 */
  createProvider(id: string): LLMProvider {
    const config = this.configs.get(id);
    if (!config) throw new Error(`Provider 不存在: ${id}`);
    return createProvider(config, this.credentials);
  }

  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitChange(): void {
    for (const listener of this.listeners) listener();
  }
}

export function validateProviderConfig(config: ProviderConfig): void {
  if (!config || typeof config !== "object") throw new Error("ProviderConfig 必须是对象");
  if (typeof config.id !== "string" || config.id.trim() === "") throw new Error("provider id 不能为空");
  if (config.type !== "anthropic" && config.type !== "openai") {
    throw new Error(`不支持的 provider 类型: ${String(config.type)}`);
  }
  if (typeof config.label !== "string" || config.label.trim() === "") throw new Error("provider label 不能为空");
  if (typeof config.baseUrl !== "string" || config.baseUrl.trim() === "") throw new Error("provider baseUrl 不能为空");
  if (typeof config.model !== "string" || config.model.trim() === "") throw new Error("provider model 不能为空");
  if (typeof config.credentialRef !== "string" || config.credentialRef.trim() === "") {
    throw new Error("provider credentialRef 不能为空");
  }
  if (typeof config.maxTokens !== "number" || !Number.isFinite(config.maxTokens) || config.maxTokens <= 0) {
    throw new Error("provider maxTokens 必须是正数");
  }
  if (config.temperature !== undefined && (typeof config.temperature !== "number" || !Number.isFinite(config.temperature))) {
    throw new Error("provider temperature 必须是有限数字");
  }
}
