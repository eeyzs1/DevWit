/**
 * 编辑运算纯函数测试（v0.7.13）：多光标删除偏移结算 + 代理对感知删除长度。
 * 抽取自 EditorView 的正确性关键路径（光标 = 下次插入点），缺陷背景见
 * 对抗性审查发现 1/7：词删除位移按「低位光标个数」近似导致高位光标漂移；
 * 按码元硬删 1 拆散代理对（emoji 乱码）。
 */
import { describe, expect, it } from "vitest";
import { backwardDeleteLength, forwardDeleteLength, multiCursorFinalOffsets } from "../src/edit-ops.js";

describe("multiCursorFinalOffsets（多光标删除偏移结算）", () => {
  it("词删除（E1 复现场景）：低位光标删多字符时，高位光标吸收实际删除长度而非光标个数", () => {
    // "xx foo bar yy"，光标 A 在 bar 后（offset 10）、B 在 foo 后（offset 6）
    // A 删 "bar"（3 字符，自身落点 7）；B 删 "foo"（3 字符，自身落点 3）
    // 期望：B 最终 3；A 最终 7 - 3 = 4（旧「个数」算法误得 7 - 1 = 6）
    const final = multiCursorFinalOffsets([10, 6], [3, 3], [7, 3]);
    expect(final).toEqual([4, 3]);
  });

  it("退格（每光标恰删 1）：与旧「个数」算法等价（回归保护）", () => {
    const final = multiCursorFinalOffsets([5, 3, 1], [1, 1, 1], [4, 2, 0]);
    expect(final).toEqual([4 - 2, 2 - 1, 0]);
  });

  it("文档首光标不删除（removedLens=0）：自身落点 0，高位光标不受影响", () => {
    const final = multiCursorFinalOffsets([8, 0], [4, 0], [4, 0]);
    expect(final).toEqual([4, 0]);
  });

  it("混合删除长度（词删除 + 代理对退格 + 文档首）：各吸收实际长度", () => {
    // 光标 0 在 offset 12：删 2 码元 emoji → 落点 10
    // 光标 1 在 offset 7：删 3 字符词 → 落点 4
    // 光标 2 在 offset 0：不删 → 落点 0
    const final = multiCursorFinalOffsets([12, 7, 0], [2, 3, 0], [10, 4, 0]);
    expect(final).toEqual([10 - 3, 4, 0]);
  });

  it("单光标：零位移（无低位光标）", () => {
    expect(multiCursorFinalOffsets([9], [5], [4])).toEqual([4]);
  });

  it("重合光标（同 offset）：按传入顺序累计，前者不吸收后者删除", () => {
    // 两光标同在 offset 6，前者删 3 落点 3；后者删 3 落点 3 但吸收前者 3 → 0
    //（重合光标最终由调用方去重，此处只锁定数值语义）
    const final = multiCursorFinalOffsets([6, 6], [3, 3], [3, 3]);
    expect(final).toEqual([3, 0]);
  });
});

describe("backwardDeleteLength（光标左侧删除长度，代理对感知）", () => {
  it("光标在 emoji 后（低代理之后）：删 2 码元", () => {
    expect(backwardDeleteLength("a😀b", 3)).toBe(2);
  });

  it("光标在普通字符后：删 1", () => {
    expect(backwardDeleteLength("abc", 2)).toBe(1);
    expect(backwardDeleteLength("abc", 1)).toBe(1);
  });

  it("光标在高代理与低代理之间（异常中间位）：删 1（低代理本身）", () => {
    // 光标 offset 2 落在代理对中间：slice(0,2)="a"+高代理，codePointAt(0)='a' → 1
    expect(backwardDeleteLength("a😀", 2)).toBe(1);
  });

  it("offset ≤ 1：删 1", () => {
    expect(backwardDeleteLength("😀", 0)).toBe(1);
    expect(backwardDeleteLength("", 0)).toBe(1);
    expect(backwardDeleteLength("x", 1)).toBe(1);
  });
});

describe("forwardDeleteLength（光标右侧删除长度，代理对感知）", () => {
  it("光标在 emoji 前（高代理之前）：删 2 码元", () => {
    expect(forwardDeleteLength("a😀b", 1)).toBe(2);
    expect(forwardDeleteLength("😀", 0)).toBe(2);
  });

  it("光标在普通字符前：删 1", () => {
    expect(forwardDeleteLength("abc", 0)).toBe(1);
    expect(forwardDeleteLength("abc", 2)).toBe(1);
  });

  it("光标在低代理上（异常中间位）：slice 首字符是低代理 → 1", () => {
    expect(forwardDeleteLength("a😀", 2)).toBe(1);
  });

  it("文档尾（空 slice）：删 1（调用方以 offset < length 守卫，不实际执行）", () => {
    expect(forwardDeleteLength("", 0)).toBe(1);
  });
});
