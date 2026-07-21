import { describe, expect, it } from "vitest";
import { EstimatedCounter, TiktokenCounter } from "../src/token-counter.js";

describe("TiktokenCounter（cl100k_base 精确计数）", () => {
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
    expect(counter.name).toBe("cl100k_base");
  });
});

describe("EstimatedCounter（Anthropic 系估算）", () => {
  it("复用内部计数器结果但标注为估算", () => {
    const counter = new EstimatedCounter();
    expect(counter.exact).toBe(false);
    expect(counter.count("hello world")).toBe(new TiktokenCounter().count("hello world"));
  });
});
