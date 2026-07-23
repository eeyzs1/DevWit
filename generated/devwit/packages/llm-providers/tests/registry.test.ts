import type { CredentialResolver, ProviderConfig } from "@devwit/contracts";
import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../src/anthropic.js";
import { OpenAiCompatibleProvider } from "../src/openai.js";
import { ProviderRegistry } from "../src/registry.js";

/** 测试用凭证解析器：返回固定测试凭证（非真实密钥）。 */
const credentials: CredentialResolver = {
  async resolve(ref: string): Promise<string> {
    return `test-credential-for-${ref}`;
  },
};

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "p1",
    type: "anthropic",
    label: "Claude",
    baseUrl: "https://example.invalid",
    model: "claude-sonnet-4-20250514",
    credentialRef: "cred-1",
    maxTokens: 1024,
    ...overrides,
  };
}

describe("ProviderRegistry", () => {
  it("register/get/list/remove 往返", () => {
    const registry = new ProviderRegistry(credentials);
    registry.register(makeConfig());
    registry.register(makeConfig({ id: "p2", type: "openai" }));
    expect(registry.list().map((c) => c.id)).toEqual(["p1", "p2"]);
    expect(registry.get("p2")?.type).toBe("openai");
    expect(registry.remove("p1")).toBe(true);
    expect(registry.get("p1")).toBeUndefined();
    expect(registry.remove("p1")).toBe(false);
  });

  it("createProvider 按 type 分发到对应实现", () => {
    const registry = new ProviderRegistry(credentials);
    registry.register(makeConfig({ id: "a", type: "anthropic" }));
    registry.register(makeConfig({ id: "o", type: "openai" }));
    expect(registry.createProvider("a")).toBeInstanceOf(AnthropicProvider);
    expect(registry.createProvider("o")).toBeInstanceOf(OpenAiCompatibleProvider);
    expect(registry.createProvider("a").config.model).toBe("claude-sonnet-4-20250514");
  });

  it("未知 id 抛错；非法配置 register 抛错", () => {
    const registry = new ProviderRegistry(credentials);
    expect(() => registry.createProvider("missing")).toThrow(/provider not found/);
    expect(() => registry.register(makeConfig({ id: "" }))).toThrow(/provider id must not be empty/);
    expect(() => registry.register(makeConfig({ maxTokens: 0 }))).toThrow(/maxTokens/);
    expect(() => registry.register(makeConfig({ baseUrl: " " }))).toThrow(/baseUrl/);
    expect(() => registry.register(makeConfig({ type: "other" as ProviderConfig["type"] }))).toThrow(/unsupported provider type/);
  });

  it("onDidChange 在 register/remove 时触发，退订后不再触发", () => {
    const registry = new ProviderRegistry(credentials);
    let count = 0;
    const unsubscribe = registry.onDidChange(() => {
      count += 1;
    });
    registry.register(makeConfig());
    registry.remove("p1");
    expect(count).toBe(2);
    unsubscribe();
    registry.register(makeConfig({ id: "p3" }));
    expect(count).toBe(2);
  });
});
