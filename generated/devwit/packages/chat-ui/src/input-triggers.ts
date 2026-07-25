/**
 * 输入框触发器解析（迭代 19 / AC28）：@文件引用 与 /斜杠命令 的纯函数判定。
 * 从 chat-panel 抽离为独立模块：不碰 DOM，vitest 直接驱动（与 chat-controller 同策略）。
 */

/** @ 触发命中：触发符在文本中的下标 + 当前已输入的查询串。 */
export interface AtTrigger {
  /** "@" 字符在 textarea value 中的下标（选中候选后删除 [start, caret) 区间）。 */
  start: number;
  /** @ 之后、光标之前的已输入查询（不含空白）。 */
  query: string;
}

/**
 * 判定光标处是否处于 @ 引用输入态。
 * 规则：从光标向左扫描，遇空白/换行即停；扫到 @ 且 @ 位于行首或前一个字符是空白则命中。
 * 查询串中不含空白（文件路径在本工作区不含空格的场景覆盖；含空格路径可从候选列表补全）。
 */
export function detectAtTrigger(text: string, caret: number): AtTrigger | null {
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === undefined) break;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") return null;
    if (ch === "@") {
      const prev = text[i - 1];
      if (i === 0 || prev === " " || prev === "\t" || prev === "\n") {
        return { start: i, query: text.slice(i + 1, caret) };
      }
      return null;
    }
    i -= 1;
  }
  return null;
}

/**
 * 判定是否处于 / 斜杠命令输入态（速切模式）。
 * 规则：文本以 / 开头，且光标在首个 token 内（/ 与第一个空白符之间）。
 * 返回已输入的命令查询（不含开头的 /）。
 */
export function detectSlashTrigger(text: string, caret: number): { query: string } | null {
  if (!text.startsWith("/")) return null;
  const firstSpace = text.search(/[ \t\n\r]/);
  const tokenEnd = firstSpace === -1 ? text.length : firstSpace;
  if (caret > tokenEnd) return null;
  return { query: text.slice(1, caret) };
}

/**
 * 文件候选过滤：大小写不敏感子串匹配，basename 命中优先于路径命中，
 * 前缀命中优先于中间命中；结果稳定排序后截断 limit。
 */
export function filterWorkspaceFiles(files: readonly string[], query: string, limit = 8): string[] {  // qg-allow: 候选下拉默认页大小，调用方可覆盖
  const q = query.toLowerCase();
  const scored: { file: string; score: number }[] = [];
  for (const file of files) {
    if (q.length === 0) {
      scored.push({ file, score: 2 });
      continue;
    }
    const lower = file.toLowerCase();
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    let score = -1;
    if (base.startsWith(q)) score = 0;
    else if (base.includes(q)) score = 1;
    else if (lower.includes(q)) score = 2;
    if (score >= 0) scored.push({ file, score });
  }
  scored.sort((a, b) => a.score - b.score || a.file.localeCompare(b.file));
  return scored.slice(0, limit).map((entry) => entry.file);
}

/**
 * 模式候选过滤（斜杠命令）：按模式 id 与显示名大小写不敏感前缀/子串匹配。
 * displayName 由调用方解析（内置模式按当前语言本地化），保持本模块不依赖 i18n。
 */
export function filterModesByQuery<T extends { id: string }>(
  modes: readonly T[],
  query: string,
  displayName: (mode: T) => string,
  limit = 8  // qg-allow: 模式候选下拉默认页大小，调用方可覆盖
): T[] {
  const q = query.toLowerCase();
  const scored: { mode: T; score: number }[] = [];
  for (const mode of modes) {
    if (q.length === 0) {
      scored.push({ mode, score: 1 });
      continue;
    }
    const id = mode.id.toLowerCase();
    const name = displayName(mode).toLowerCase();
    let score = -1;
    if (id.startsWith(q) || name.startsWith(q)) score = 0;
    else if (id.includes(q) || name.includes(q)) score = 1;
    if (score >= 0) scored.push({ mode, score });
  }
  scored.sort((a, b) => a.score - b.score || displayName(a.mode).localeCompare(displayName(b.mode)));
  return scored.slice(0, limit).map((entry) => entry.mode);
}
