import { describe, expect, it } from "vitest";
import { decideRoute, DEFAULT_ROUTING, parseRoutingConfig, scoreTaskComplexity } from "../src/task-router.js";

const CONFIG = { enabled: true, providerId: "p-local", threshold: 30 };

describe("scoreTaskComplexity（AC31 可解释启发式）", () => {
  it("空信号 = 0 分判简单；reasons 为空", () => {
    const result = scoreTaskComplexity({ userText: "改一下按钮颜色" });
    expect(result.score).toBe(0);
    expect(result.reasons).toEqual([]);
  });

  it("长文本 +15 且记录 long_text", () => {
    const result = scoreTaskComplexity({ userText: "x".repeat(201) });
    expect(result.score).toBe(15);
    expect(result.reasons).toEqual(["long_text"]);
  });

  it("复杂关键词每个 +15 封顶 30；中英关键词都识别", () => {
    const zh = scoreTaskComplexity({ userText: "重构整个项目的架构并迁移所有文件" });
    expect(zh.score).toBe(30); // refactor + migrate + whole_scope → 封顶
    expect(zh.reasons.some((r) => r.startsWith("keyword:"))).toBe(true);
    const en = scoreTaskComplexity({ userText: "please refactor and rewrite this module" });
    expect(en.score).toBe(30);
  });

  it("单个复杂信号（+15）不足默认阈值 30，判简单——阈值边界可解释", () => {
    const d = decideRoute(CONFIG, { userText: "重构这个函数", fallbackProviderId: "p-cloud", localAvailable: true });
    expect(d.routed).toBe("local");
    expect(d.score).toBe(15);
  });

  it("编排模式 +40（必判复杂）；附件 ≥3 +10", () => {
    expect(scoreTaskComplexity({ userText: "短", orchestrate: true }).score).toBe(40);
    expect(
      scoreTaskComplexity({ userText: "短", attachments: ["a", "b", "c"] }).score
    ).toBe(10);
    expect(
      scoreTaskComplexity({ userText: "短", attachments: ["a", "b"] }).score
    ).toBe(0);
  });
});

describe("decideRoute（AC31 路由决策）", () => {
  const BASE = { userText: "改颜色", fallbackProviderId: "p-cloud", localAvailable: true };

  it("简单任务 → 本地 provider", () => {
    const d = decideRoute(CONFIG, BASE);
    expect(d).toMatchObject({ routed: "local", providerId: "p-local", score: 0, threshold: 30 });
  });

  it("复杂任务（score ≥ threshold）→ 模式绑定", () => {
    const d = decideRoute(CONFIG, { ...BASE, userText: "重构整个项目架构" });
    expect(d.routed).toBe("complex");
    expect(d.providerId).toBe("p-cloud");
  });

  it("边界：score == threshold 判复杂", () => {
    const d = decideRoute(CONFIG, { ...BASE, orchestrate: true }); // 40 ≥ 30
    expect(d.routed).toBe("complex");
  });

  it("开关关闭 → disabled，走模式绑定", () => {
    const d = decideRoute({ ...CONFIG, enabled: false }, BASE);
    expect(d).toMatchObject({ routed: "disabled", providerId: "p-cloud" });
  });

  it("本地 provider 未配置/未注册 → unavailable 回退", () => {
    expect(decideRoute({ ...CONFIG, providerId: "" }, BASE).routed).toBe("unavailable");
    expect(decideRoute(CONFIG, { ...BASE, localAvailable: false }).routed).toBe("unavailable");
    expect(decideRoute(CONFIG, { ...BASE, localAvailable: false }).providerId).toBe("p-cloud");
  });

  it("用户手动切模型 → manual，跳过路由（即使任务简单）", () => {
    const d = decideRoute(CONFIG, { ...BASE, manualOverride: true });
    expect(d).toMatchObject({ routed: "manual", providerId: "p-cloud" });
  });
});

describe("parseRoutingConfig（settings 反序列化）", () => {
  it("缺省/非法 → 默认关、阈值 30", () => {
    expect(parseRoutingConfig(undefined)).toEqual(DEFAULT_ROUTING);
    expect(parseRoutingConfig(null)).toEqual(DEFAULT_ROUTING);
    expect(parseRoutingConfig("x")).toEqual(DEFAULT_ROUTING);
    expect(parseRoutingConfig({ enabled: "yes" }).enabled).toBe(false);
  });

  it("合法配置透传；阈值取整且下限 1", () => {
    expect(parseRoutingConfig({ enabled: true, providerId: "p1", threshold: 25.7 })).toEqual({
      enabled: true,
      providerId: "p1",
      threshold: 25,
    });
    expect(parseRoutingConfig({ enabled: true, providerId: "p1", threshold: 0 }).threshold).toBe(30);
  });
});
