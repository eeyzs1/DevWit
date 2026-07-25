import type { ContextCollectInput } from "@devwit/contracts";
import { describe, expect, it } from "vitest";
import {
  attachmentSource,
  conversationHistorySource,
  fileFragmentSource,
  gitStatusSource,
  selectionSource,
  serializeConversationHistory,
  terminalTailSource,
} from "../src/sources.js";

function makeInput(overrides: Partial<ContextCollectInput> = {}): ContextCollectInput {
  return { conversationHistory: [], ...overrides };
}

describe("selectionSource", () => {
  it("无选区或选区为空文本时不产生项", async () => {
    const source = selectionSource();
    expect(await source.collect(makeInput())).toEqual([]);
    expect(await source.collect(makeInput({ selection: { text: "", startLine: 1, endLine: 1 } }))).toEqual([]);
  });

  it("有选区时产出带行号标签与来源文件的项", async () => {
    const source = selectionSource();
    const items = await source.collect(
      makeInput({ activeFile: "src/a.ts", selection: { text: "const x = 1;", startLine: 3, endLine: 5 } })
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe("selection");
    expect(items[0]?.label).toBe("选区 L3-L5");
    expect(items[0]?.content).toBe("const x = 1;");
    expect(items[0]?.source).toBe("src/a.ts");
  });
});

describe("fileFragmentSource", () => {
  it("无活动文件时不产生项", async () => {
    const source = fileFragmentSource(async () => "内容");
    expect(await source.collect(makeInput())).toEqual([]);
  });

  it("文件内容经注入的 readFile 提供（引擎不碰 fs）", async () => {
    const seen: string[] = [];
    const source = fileFragmentSource(async (path) => {
      seen.push(path);
      return "file-body";
    });
    const items = await source.collect(makeInput({ activeFile: "src/main.ts" }));
    expect(seen).toEqual(["src/main.ts"]);
    expect(items[0]?.type).toBe("file_fragment");
    expect(items[0]?.content).toBe("file-body");
    expect(items[0]?.source).toBe("src/main.ts");
  });
});

describe("attachmentSource（迭代 19 / AC28 @文件引用）", () => {
  it("无 attachments 或空数组时不产生项", async () => {
    const source = attachmentSource(async () => "内容");
    expect(await source.collect(makeInput())).toEqual([]);
    expect(await source.collect(makeInput({ attachments: [] }))).toEqual([]);
  });

  it("每个引用产出独立 file_fragment 项，key=attachment:<路径> 稳定", async () => {
    const seen: string[] = [];
    const source = attachmentSource(async (filePath) => {
      seen.push(filePath);
      return `body-of-${filePath}`;
    });
    const items = await source.collect(makeInput({ attachments: ["src/a.ts", "docs/readme.md"] }));
    expect(seen).toEqual(["src/a.ts", "docs/readme.md"]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      type: "file_fragment",
      label: "引用文件 src/a.ts",
      content: "body-of-src/a.ts",
      source: "attachment",
      key: "attachment:src/a.ts",
    });
    expect(items[1]?.key).toBe("attachment:docs/readme.md");
  });

  it("单文件读取失败跳过该附件，不阻断其余引用", async () => {
    const source = attachmentSource(async (filePath) => {
      if (filePath === "gone.ts") throw new Error("ENOENT");
      return "ok-body";
    });
    const items = await source.collect(makeInput({ attachments: ["gone.ts", "ok.ts"] }));
    expect(items).toHaveLength(1);
    expect(items[0]?.key).toBe("attachment:ok.ts");
  });
});

describe("gitStatusSource", () => {
  it("无 workspaceRoot 时不产生项", async () => {
    const source = gitStatusSource(async () => "M a.ts");
    expect(await source.collect(makeInput())).toEqual([]);
  });

  it("git 状态经注入的 getStatus 提供", async () => {
    const source = gitStatusSource(async (root) => `status-of-${root}`);
    const items = await source.collect(makeInput({ workspaceRoot: "/repo" }));
    expect(items[0]?.type).toBe("git_status");
    expect(items[0]?.content).toBe("status-of-/repo");
  });
});

describe("terminalTailSource", () => {
  it("优先取 input.terminalTail，缺省时回退注入 provider，两者皆无不产项", async () => {
    const withProvider = terminalTailSource(() => "provider-tail");
    expect((await withProvider.collect(makeInput({ terminalTail: "input-tail" })))[0]?.content).toBe("input-tail");
    expect((await withProvider.collect(makeInput()))[0]?.content).toBe("provider-tail");
    expect(await terminalTailSource().collect(makeInput())).toEqual([]);
  });
});

describe("conversationHistorySource", () => {
  it("空历史不产项；非空历史序列化为可审计文本", async () => {
    const source = conversationHistorySource();
    expect(await source.collect(makeInput())).toEqual([]);
    const items = await source.collect(
      makeInput({
        conversationHistory: [
          { role: "user", content: "你好" },
          { role: "assistant", content: "在的" },
        ],
      })
    );
    expect(items[0]?.type).toBe("conversation_history");
    expect(items[0]?.content).toBe("[user] 你好\n[assistant] 在的");
  });
});

describe("serializeConversationHistory", () => {
  it("逐条序列化为 [role] content 行", () => {
    expect(serializeConversationHistory([{ role: "tool", content: "ok", toolCallId: "t1" }])).toBe("[tool] ok");
  });
});
