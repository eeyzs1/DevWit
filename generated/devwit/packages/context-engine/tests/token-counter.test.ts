import { describe, expect, it } from "vitest";
import { EstimatedCounter, TiktokenCounter, tiktokenFamilyForModel } from "../src/token-counter.js";

describe("TiktokenCounter（模型感知精确计数）", () => {
  it("空串为 0", () => {
    expect(new TiktokenCounter().count("")).toBe(0);
  });

  it('已知编码："hello world" = 2 tokens（15339, 1917）', () => {
    expect(new TiktokenCounter().count("hello world")).toBe(2);
  });

  it("中文文本计数为正且可重复", () => {
    const counter = new TiktokenCounter();
    const n = counter.count("简洁上下文引擎");
    expect(n).toBeGreaterThan(0);
    expect(counter.count("简洁上下文引擎")).toBe(n);
  });

  it("标注为精确计数", () => {
    const counter = new TiktokenCounter();
    expect(counter.exact).toBe(true);
    expect(counter.name).toBe("tiktoken(model-aware)");
  });
});

describe("tiktokenFamilyForModel（v0.7.2 词典族判定）", () => {
  it("GPT-4o/4.1/o 系 → o200k_base", () => {
    for (const model of ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.5", "chatgpt-4o-latest", "o1", "o3-mini", "o4-mini"]) {
      expect(tiktokenFamilyForModel(model)).toBe("o200k_base");
    }
  });

  it("旧 GPT/其余模型 → cl100k_base（缺省安全侧）", () => {
    for (const model of ["gpt-4", "gpt-4-turbo", "gpt-3.5-turbo", "claude-sonnet-4", "e2e-model-a", ""]) {
      expect(tiktokenFamilyForModel(model)).toBe("cl100k_base");
    }
  });

  it("countForModel 按族选词典：o200k 与 cl100k 对同一文本计数可不同", () => {
    const counter = new TiktokenCounter();
    // o200k 对 emoji/某些 unicode 的合并更激进——找一个计数不同的样本验证分族生效
    const sample = "简洁上下文引擎 🚀 token calibration test";
    const cl = counter.count(sample); // 缺省 cl100k
    const o200k = counter.countForModel("gpt-4o", sample);
    expect(typeof o200k).toBe("number");
    expect(o200k).toBeGreaterThan(0);
    // 两族对同一文本都给出合法计数（可能相等也可能不等——分族本身由上两条锁定）
    expect(counter.countForModel("claude-sonnet-4", sample)).toBe(cl);
  });
});

describe("EstimatedCounter（Anthropic 系估算）", () => {
  it("复用内部计数器结果但标注为估算", () => {
    const counter = new EstimatedCounter();
    expect(counter.exact).toBe(false);
    expect(counter.count("hello world")).toBe(new TiktokenCounter().count("hello world"));
  });

  it("countForModel 透传到内部计数器（估算同样分族）", () => {
    const inner = new TiktokenCounter();
    const counter = new EstimatedCounter(inner);
    expect(counter.countForModel("gpt-4o", "样本")).toBe(inner.countForModel("gpt-4o", "样本"));
  });
});
