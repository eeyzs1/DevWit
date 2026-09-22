import { describe, expect, it } from "vitest";
import { extractEditProposal } from "../src/edit-proposal.js";

describe("extractEditProposal", () => {
  it("恰好一个围栏块：提取内容与语言标记", () => {
    const text = "这是修改后的代码：\n```ts\nconst a = 1;\nconst b = 2;\n```\n以上。";
    expect(extractEditProposal(text)).toEqual({ code: "const a = 1;\nconst b = 2;", language: "ts" });
  });

  it("无语言标记：language 为 undefined", () => {
    const text = "```\nplain text\n```";
    expect(extractEditProposal(text)).toEqual({ code: "plain text" });
  });

  it("保留内部缩进与空行，仅去掉收尾换行", () => {
    const text = "```python\ndef f():\n    pass\n\n    return 1\n```";
    expect(extractEditProposal(text)?.code).toBe("def f():\n    pass\n\n    return 1");
  });

  it("无代码块 → null（普通对话，不做 diff）", () => {
    expect(extractEditProposal("只是解释，没有代码。")).toBeNull();
  });

  it("多个代码块 → null（不满足单块契约，诚实降级）", () => {
    const text = "```ts\na\n```\n还有：\n```ts\nb\n```";
    expect(extractEditProposal(text)).toBeNull();
  });

  it("空代码块 → code 为空串", () => {
    expect(extractEditProposal("```\n\n```")).toEqual({ code: "" });
  });

  it("v0.7.16（审查 C4）：替换内容含 ``` 行（内层围栏假闭合）→ null（不截断提取）", () => {
    // 旧实现：非贪婪在第一个 ``` 闭合 → 恰好 1 个匹配 → code="foo"（残缺）
    const text = "```md\nfoo\n```\nbar\n```\nend";
    expect(extractEditProposal(text)).toBeNull();
  });

  it("v0.7.16（审查 C4）：闭合后尾部再出现 ``` → null（视为多块，诚实降级）", () => {
    const text = "```ts\nconst a = 1;\n```\n附注：\n```";
    expect(extractEditProposal(text)).toBeNull();
  });
});
