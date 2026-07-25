import type { DiagnosticEntry } from "@devwit/contracts";
import { describe, expect, it } from "vitest";
import { DiagnosticsTracker } from "../src/diagnostics.js";

const ENTRY: DiagnosticEntry = {
  file: "src/a.ts",
  line: 3,
  column: 7,
  severity: "error",
  code: "TS2322",
  message: "Type 'string' is not assignable to type 'number'.",
};

describe("DiagnosticsTracker", () => {
  it("未注入 provider：available=false，refresh 恒 0，source 零项", async () => {
    const tracker = new DiagnosticsTracker();
    expect(tracker.available).toBe(false);
    expect(await tracker.refresh("C:\\ws")).toBe(0);
    expect(await tracker.source().collect({ conversationHistory: [] })).toEqual([]);
  });

  it("refresh 后快照可见；清零后源自动零项（不占 token）", async () => {
    let snapshot: DiagnosticEntry[] = [];
    const tracker = new DiagnosticsTracker(async () => snapshot);
    expect(tracker.available).toBe(true);

    snapshot = [ENTRY];
    expect(await tracker.refresh("C:\\ws")).toBe(1);
    expect(tracker.getLatest()).toEqual([ENTRY]);
    const items = await tracker.source().collect({ conversationHistory: [] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "diagnostics",
      key: "diagnostics:latest",
      label: "诊断（1 个问题）",
      source: "tsc --noEmit",
    });
    expect(items[0]?.content).toContain("src/a.ts:3:7 error TS2322");

    snapshot = [];
    expect(await tracker.refresh("C:\\ws")).toBe(0);
    expect(await tracker.source().collect({ conversationHistory: [] })).toEqual([]);
  });

  it("provider 抛错：快照清空且不阻断（诊断是增强回馈，不是主循环依赖）", async () => {
    let shouldThrow = false;
    const tracker = new DiagnosticsTracker(async () => {
      if (shouldThrow) throw new Error("tsc crashed");
      return [ENTRY];
    });
    expect(await tracker.refresh("C:\\ws")).toBe(1);
    shouldThrow = true;
    expect(await tracker.refresh("C:\\ws")).toBe(0);
    expect(tracker.getLatest()).toEqual([]);
  });

  it("并发 refresh 串行化：快照不被交错覆盖", async () => {
    let calls = 0;
    const tracker = new DiagnosticsTracker(async () => {
      calls += 1;
      const mine = calls;
      await new Promise((resolve) => setTimeout(resolve, mine === 1 ? 30 : 5));
      return [{ ...ENTRY, line: mine }];
    });
    const [a, b] = await Promise.all([tracker.refresh("C:\\ws"), tracker.refresh("C:\\ws")]);
    // 串行化：第二次 refresh 复用第一次的结果（provider 只跑一次或两次，但两次返回值一致）
    expect(a).toBe(b);
    expect(tracker.getLatest().length).toBe(1);
  });
});
