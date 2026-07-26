/**
 * 对话会话列表纯函数测试（迭代 28 / AC37）：
 * displaySessionTitle（折叠空白/截断/空标题回退）/ formatSessionLastAt（当天时分、跨天日期）。
 * DOM 组件不在 node 环境测试（与 trace-timeline 同约定），只覆盖导出纯函数。
 */
import { describe, expect, it } from "vitest";
import { displaySessionTitle, formatSessionLastAt } from "../src/session-list.js";

describe("displaySessionTitle（AC37 列表标题）", () => {
  it("折叠连续空白并截断超长标题（默认 30 字 + 省略号）", () => {
    expect(displaySessionTitle("  多行\n标题\t带  空白  ")).toBe("多行 标题 带 空白");
    const long = "一".repeat(40);
    const out = displaySessionTitle(long);
    expect(out).toBe(`${"一".repeat(30)}…`);
    expect(out.length).toBe(31);
  });

  it("空标题/全空白回退到「新会话」文案（i18n 词典键 sessions.new）", () => {
    expect(displaySessionTitle("")).toBe("新会话");
    expect(displaySessionTitle("   \n  ")).toBe("新会话");
  });

  it("自定义 max：短标题不截断", () => {
    expect(displaySessionTitle("abcdef", 3)).toBe("abc…");
    expect(displaySessionTitle("abc", 3)).toBe("abc");
  });
});

describe("formatSessionLastAt（AC37 末活动时间）", () => {
  const now = new Date(2026, 6, 26, 15, 30); // 本地时区 2026-07-26 15:30

  it("当天显示 HH:MM（补零）", () => {
    const morning = new Date(2026, 6, 26, 9, 5).toISOString();
    expect(formatSessionLastAt(morning, now)).toBe("09:05");
  });

  it("跨天显示 YYYY-MM-DD", () => {
    const yesterday = new Date(2026, 6, 25, 23, 59).toISOString();
    expect(formatSessionLastAt(yesterday, now)).toBe("2026-07-25");
    const lastYear = new Date(2025, 11, 31, 10, 0).toISOString();
    expect(formatSessionLastAt(lastYear, now)).toBe("2025-12-31");
  });

  it("非法时间串返回空串（不抛异常）", () => {
    expect(formatSessionLastAt("not-a-date", now)).toBe("");
  });
});
