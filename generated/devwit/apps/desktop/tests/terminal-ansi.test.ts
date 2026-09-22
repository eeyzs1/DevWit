import { describe, expect, it } from "vitest";
import { parseAnsi } from "../src/renderer/terminal-ansi.js";

describe("parseAnsi（纯函数）", () => {
  it("纯文本原样通过", () => {
    expect(parseAnsi("hello world")).toEqual([{ text: "hello world", classNames: [] }]);
  });

  it("空输入 → 空段列表", () => {
    expect(parseAnsi("")).toEqual([]);
  });

  it("SGR 前景色 + 复位", () => {
    const out = parseAnsi("\u001b[31mred\u001b[0mplain");
    expect(out).toEqual([
      { text: "red", classNames: ["ansi-fg-red"] },
      { text: "plain", classNames: [] },
    ]);
  });

  it("SGR 组合参数（粗体+前景）", () => {
    const out = parseAnsi("\u001b[1;32mgreen bold");
    expect(out).toEqual([{ text: "green bold", classNames: ["ansi-bold", "ansi-fg-green"] }]);
  });

  it("亮色（90-97）与背景色", () => {
    const out = parseAnsi("\u001b[93;44mtext");
    expect(out[0]?.classNames).toContain("ansi-fg-bright-yellow");
    expect(out[0]?.classNames).toContain("ansi-bg-blue");
  });

  it("39/49 清除前景/背景但保留粗体", () => {
    const out = parseAnsi("\u001b[1;31;44mx\u001b[39;49my");
    expect(out[0]?.classNames).toEqual(["ansi-bold", "ansi-fg-red", "ansi-bg-blue"]);
    expect(out[1]?.classNames).toEqual(["ansi-bold"]);
  });

  it("256 色（38;5;n）近似到基础色", () => {
    const out = parseAnsi("\u001b[38;5;196mX");
    expect(out[0]?.classNames).toContain("ansi-fg-white");
  });

  it("光标控制序列（CUU/CUD/EL 等）剥离，文本保留", () => {
    const out = parseAnsi("a\u001b[2Ab\u001b[0Kc\u001b[3Gd");
    expect(out).toEqual([{ text: "abcd", classNames: [] }]);
  });

  it("OSC（标题）序列剥离", () => {
    const out = parseAnsi("\u001b]0;my title\u0007visible");
    expect(out).toEqual([{ text: "visible", classNames: [] }]);
    // ST 结尾变体
    expect(parseAnsi("\u001b]2;tab\u001b\\x")).toEqual([{ text: "x", classNames: [] }]);
  });

  it("两字符转义（ESC 7 / ESC M）剥离", () => {
    expect(parseAnsi("a\u001b7b\u001bMc")).toEqual([{ text: "abc", classNames: [] }]);
  });

  it("流截断的不完整 CSI 按字面输出（调用方拼接后重解析）", () => {
    const out = parseAnsi("text\u001b[3");
    expect(out).toEqual([{ text: "text\u001b[3", classNames: [] }]);
  });

  it("样式跨多段保持（无复位时延续）", () => {
    const out = parseAnsi("\u001b[31ma\u001b[32mb");
    expect(out).toEqual([
      { text: "a", classNames: ["ansi-fg-red"] },
      { text: "b", classNames: ["ansi-fg-green"] },
    ]);
  });

  it("反显 + 取消反显", () => {
    const out = parseAnsi("\u001b[7minv\u001b[27mplain");
    expect(out[0]?.classNames).toContain("ansi-inverse");
    expect(out[1]?.classNames).not.toContain("ansi-inverse");
  });

  it("真实 shell 场景：ls 彩色输出的混合流", () => {
    const raw = "dir\u001b[0m \u001b[01;34mfile.ts\u001b[0m\n";
    const out = parseAnsi(raw);
    expect(out.map((segment) => segment.text).join("")).toContain("dir file.ts");
    expect(out.some((segment) => segment.classNames.includes("ansi-fg-blue"))).toBe(true);
  });
});
