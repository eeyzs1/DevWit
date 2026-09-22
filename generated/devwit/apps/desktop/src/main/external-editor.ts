/**
 * 外部编辑器打开（迭代 2 / AC10）。
 *
 * settings["externalEditor"].command 为命令模板，占位符 {file}（必需）、
 * {line}（缺省 1）。本模块把模板解析为可执行命令并真实 spawn 子进程
 * （detached + unref，不阻塞主进程、不随应用退出而被杀）。
 *
 * 本文件不 import electron——纯函数 tokenizeTemplate / buildEditorCommand
 * 可在 vitest 中直接测试；openInExternalEditor 用真实子进程做集成验证。
 */
import { spawn } from "node:child_process";

export class ExternalEditorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExternalEditorError";
  }
}

/**
 * 按空白分词但保留双引号段（引号内可含空格路径）。
 * 例：'"C:\\Tools\\Code.exe" -g {file}' → ['C:\\Tools\\Code.exe', '-g', '{file}']
 * v0.7.24（审查 R7-16a）：路径中段的引号（C:\"My Tools"\code.exe）旧实现
 * 切成两个错误 token——非成对引号现在回退为普通空白分词（诚实降级，
 * 不产生半截命令）。
 */
export function tokenizeTemplate(template: string): string[] {
  const balanced = (template.match(/"/g) ?? []).length % 2 === 0;
  if (!balanced) {
    return template.trim().split(/\s+/).filter((token) => token !== "");
  }
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(template)) !== null) {
    tokens.push(match[1] ?? match[2] ?? "");
  }
  return tokens;
}

/**
 * 模板 + 文件/行号 → { cmd, args }。
 * 模板必须包含 {file}（否则用户点"打开"时编辑器不知道开什么——明确报错）。
 */
export function buildEditorCommand(
  template: string,
  file: string,
  line = 1
): { cmd: string; args: string[] } {
  const trimmed = template.trim();
  if (trimmed === "") {
    // 错误码保持 ASCII：主进程 stderr 防 GBK 终端乱码，文案由渲染端 localizeError 本地化
    throw new ExternalEditorError("DW_EXTERNAL_EDITOR_TEMPLATE_EMPTY");
  }
  if (!trimmed.includes("{file}")) {
    throw new ExternalEditorError("DW_EXTERNAL_EDITOR_MISSING_FILE_PLACEHOLDER");
  }
  // v0.7.24（审查 R7-16b）：非有限行号（NaN/Infinity 经异常调用路径传入）兜底 1
  // ——旧实现 Math.floor(NaN)=NaN 使命令行出现字面量 ":NaN"
  const safeLine = Number.isFinite(line) ? Math.max(1, Math.floor(line)) : 1;
  const tokens = tokenizeTemplate(trimmed).map((token) =>
    token.replaceAll("{file}", file).replaceAll("{line}", String(safeLine))
  );
  const [cmd, ...args] = tokens;
  if (cmd === undefined || cmd === "") {
    throw new ExternalEditorError("DW_EXTERNAL_EDITOR_TEMPLATE_EMPTY");
  }
  return { cmd, args };
}

/**
 * 真实 spawn 外部编辑器。resolve 于进程成功启动（spawn 事件），
 * reject 于可执行文件不存在等启动失败（error 事件）。
 */
export function openInExternalEditor(template: string, file: string, line = 1): Promise<void> {
  const { cmd, args } = buildEditorCommand(template, file, line);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.once("error", (error) => {
      // node 的 spawn error.message 为 ASCII（含 syscall 与命令名），可直接入 stderr
      reject(new ExternalEditorError(`DW_EXTERNAL_EDITOR_SPAWN_FAILED:${error.message}`));
    });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
