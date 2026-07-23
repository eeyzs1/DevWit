/**
 * 外部编辑器（AC10）单元测试。
 * tokenizeTemplate / buildEditorCommand 为纯函数；
 * openInExternalEditor 用 process.execPath（node）做真实 spawn 集成验证——
 * 被 spawn 的 node 进程真实启动并立即退出，证明命令解析→启动链路为真。
 */
import { describe, expect, it } from "vitest";
import {
  buildEditorCommand,
  ExternalEditorError,
  openInExternalEditor,
  tokenizeTemplate,
} from "../src/main/external-editor.js";

describe("tokenizeTemplate", () => {
  it("按空白分词", () => {
    expect(tokenizeTemplate("code -g {file}:{line}")).toEqual(["code", "-g", "{file}:{line}"]);
  });

  it("保留双引号段（引号内含空格路径）", () => {
    expect(tokenizeTemplate('"C:\\Program Files\\VS Code\\Code.exe" -g {file}')).toEqual([
      "C:\\Program Files\\VS Code\\Code.exe",
      "-g",
      "{file}",
    ]);
  });

  it("空模板 → 空数组", () => {
    expect(tokenizeTemplate("   ")).toEqual([]);
  });
});

describe("buildEditorCommand", () => {
  it("替换 {file} 与 {line}", () => {
    expect(buildEditorCommand('code -g "{file}:{line}"', "D:\\proj\\a.ts", 42)).toEqual({
      cmd: "code",
      args: ["-g", "D:\\proj\\a.ts:42"],
    });
  });

  it("{line} 缺省为 1", () => {
    expect(buildEditorCommand("subl {file}:{line}", "/tmp/x.ts")).toEqual({
      cmd: "subl",
      args: ["/tmp/x.ts:1"],
    });
  });

  it("line 向下取整且最小为 1", () => {
    const { args } = buildEditorCommand("e {file}:{line}", "f", 0);
    expect(args).toEqual(["f:1"]);
  });

  it("缺少 {file} 占位符 → 明确报错", () => {
    expect(() => buildEditorCommand("code --new-window", "a.ts")).toThrow(ExternalEditorError);
  });

  it("空模板 → 明确报错", () => {
    expect(() => buildEditorCommand("  ", "a.ts")).toThrow(ExternalEditorError);
  });
});

describe("openInExternalEditor（真实 spawn）", () => {
  it("以 node 为『编辑器』真实启动子进程", async () => {
    // 模板："<node>" -e "process.exit(0)" "{file}" —— 真实 spawn，立即退出
    const template = `"${process.execPath}" -e process.exit(0) "{file}"`;
    await expect(openInExternalEditor(template, "D:\\any\\file.ts")).resolves.toBeUndefined();
  });

  it("可执行文件不存在 → reject 且附命令名", async () => {
    await expect(
      openInExternalEditor("definitely-not-a-real-editor-xyz {file}", "a.ts")
    ).rejects.toThrow(/DW_EXTERNAL_EDITOR_SPAWN_FAILED/);
  });
});
