import type { ProviderPreset } from "@devwit/contracts";
import { describe, expect, it } from "vitest";
import { PROVIDER_PRESETS } from "../src/presets.js";

describe("PROVIDER_PRESETS 预设目录（AC22）", () => {
  it("全部预设为 openai 兼容类型且 baseUrl 非空、id 唯一", () => {
    const ids = new Set<string>();
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.type).toBe("openai");
      expect(preset.baseUrl.length).toBeGreaterThan(0);
      expect(preset.label.length).toBeGreaterThan(0);
      expect(Array.isArray(preset.models)).toBe(true);
      expect(typeof preset.keyless).toBe("boolean");
      expect(ids.has(preset.id)).toBe(false);
      ids.add(preset.id);
    }
  });

  it("存在免 key 本地预设（Ollama），且 keyless 预设仅它一个", () => {
    const keyless = PROVIDER_PRESETS.filter((preset) => preset.keyless);
    expect(keyless.map((preset) => preset.id)).toEqual(["ollama"]);
    expect(keyless[0]?.baseUrl).toContain("localhost");
  });

  it("keyless 之外的预设均需用户自填 key（keyless=false）", () => {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.id !== "ollama") {
        expect(preset.keyless).toBe(false);
      }
    }
  });

  it("预设形状满足 ProviderPreset 契约（编译期类型 + 运行时字段齐全）", () => {
    const preset: ProviderPreset | undefined = PROVIDER_PRESETS[0];
    expect(preset).toBeDefined();
    expect(Object.keys(preset ?? {}).sort()).toEqual(["baseUrl", "id", "keyless", "label", "models", "type"]);
  });
});
