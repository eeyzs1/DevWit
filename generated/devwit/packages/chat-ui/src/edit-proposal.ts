/**
 * 从 assistant 文本中提取"选区替换提案"的代码块。
 *
 * 契约（写入 chat 模式系统提示）：模型用恰好一个 ``` 围栏代码块给出
 * 选区的替换内容，不输出其他代码块。提取规则：
 * - 恰好一个围栏块 → 返回其内容与语言标记；
 * - 0 个或多个块 → 返回 null（调用方按普通对话消息展示，不做 diff）。
 * 这是确定性解析：不猜测、不截断——不满足契约即无提案，诚实降级。
 */
export interface EditProposal {
  /** 围栏内的代码内容（不含围栏行）。 */
  code: string;
  /** 围栏语言标记（如 ts/python），无标记为 undefined。 */
  language?: string;
}

const FENCE_PATTERN = /```([^\n`]*)\n([\s\S]*?)```/g;

export function extractEditProposal(assistantText: string): EditProposal | null {
  const matches = [...assistantText.matchAll(FENCE_PATTERN)];
  if (matches.length !== 1) {
    return null;
  }
  const match = matches[0];
  if (match === undefined) {
    return null;
  }
  // v0.7.16 修复（审查 C4）：首个闭合后剩余文本仍含 ``` → 非贪婪匹配在
  // 内层围栏处假闭合（替换内容本身含 ``` 行时常见，改 markdown 文件）。
  // 旧实现恰好 1 个匹配即通过——提取的是被截断的内容，「接受」后写入残缺
  // 代码。按多块契约诚实降级返回 null（普通对话展示，不 diff）。
  const matchEnd = (match.index ?? 0) + match[0].length;
  if (assistantText.slice(matchEnd).includes("```")) {
    return null;
  }
  const language = (match[1] ?? "").trim();
  let code = match[2] ?? "";
  // 围栏内容按行对齐：去掉收尾的单个换行，保留内部结构与缩进
  if (code.endsWith("\n")) {
    code = code.slice(0, -1);
  }
  return {
    code,
    ...(language.length > 0 ? { language } : {}),
  };
}
