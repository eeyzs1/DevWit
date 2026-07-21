import { describe, expect, it } from "vitest";
import { applyDecisions, computeDiff, DiffController } from "../src/diff-controller.js";

describe("computeDiff", () => {
  it("无变更：无 hunk，hasChanges=false", () => {
    const computation = computeDiff("a\nb\nc", "a\nb\nc");
    expect(computation.hasChanges).toBe(false);
    expect(computation.hunks).toHaveLength(0);
  });

  it("单处修改聚为一个 hunk，context 行在段序列中保留", () => {
    const computation = computeDiff("one\ntwo\nthree", "one\nTWO\nthree");
    expect(computation.hunks).toHaveLength(1);
    const hunk = computation.hunks[0];
    expect(hunk?.lines).toEqual([
      { kind: "remove", text: "two" },
      { kind: "add", text: "TWO" },
    ]);
    expect(computation.segments.map((segment) => segment.kind)).toEqual(["context", "hunk", "context"]);
  });

  it("相距足够远的多处修改聚为多个 hunk", () => {
    const original = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8";
    const proposal = "L1\nl2\nl3\nl4\nl5\nl6\nl7\nL8";
    const computation = computeDiff(original, proposal);
    expect(computation.hunks.length).toBeGreaterThanOrEqual(2);
  });

  it("纯新增行：hunk 仅含 add 行", () => {
    const computation = computeDiff("a\nb", "a\nx\nb");
    expect(computation.hunks).toHaveLength(1);
    expect(computation.hunks[0]?.lines).toEqual([{ kind: "add", text: "x" }]);
  });
});

describe("DiffController 裁决合成", () => {
  const original = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight";
  const proposal = "one\nTWO\nthree\nfour\nfive\nsix\nSEVEN\neight";

  it("accepted 取新增行，rejected 保留原始行，pending 不默认应用", () => {
    const controller = new DiffController(original, proposal);
    expect(controller.hunks.length).toBe(2);

    controller.accept(1);
    controller.reject(2);
    const result = controller.result();
    expect(result).toContain("TWO");
    expect(result).toContain("seven");
    expect(result).not.toContain("SEVEN");
  });

  it("pending 按安全侧处理（不应用），allDecided 门控应用", () => {
    const controller = new DiffController(original, proposal);
    expect(controller.allDecided).toBe(false);
    expect(controller.result()).toBe(original); // 全部 pending → 不应用任何变更
    controller.acceptAll();
    expect(controller.allDecided).toBe(true);
    expect(controller.result()).toBe(proposal);
  });

  it("rejectAll 后结果恒等于原文", () => {
    const controller = new DiffController(original, proposal);
    controller.rejectAll();
    expect(controller.allDecided).toBe(true);
    expect(controller.result()).toBe(original);
  });

  it("onChange 在裁决时触发", () => {
    const controller = new DiffController(original, proposal);
    let fired = 0;
    controller.onChange(() => {
      fired += 1;
    });
    controller.accept(1);
    controller.rejectAll();
    expect(fired).toBe(2);
  });

  it("applyDecisions 纯函数与控制器 result 一致", () => {
    const controller = new DiffController(original, proposal);
    controller.accept(1);
    controller.reject(2);
    const computation = computeDiff(original, proposal);
    computation.hunks[0]!.decision = "accepted";
    computation.hunks[1]!.decision = "rejected";
    expect(applyDecisions(computation)).toBe(controller.result());
  });

  it("选区替换场景：整体替换为多行（WU013 核心路径）", () => {
    const selection = "function add(a, b) {\n  return a + b;\n}";
    const replacement = "function add(a: number, b: number): number {\n  // 类型注解\n  return a + b;\n}";
    const controller = new DiffController(selection, replacement);
    expect(controller.hasChanges).toBe(true);
    controller.acceptAll();
    expect(controller.result()).toBe(replacement);
  });
});
