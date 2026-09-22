/**
 * 命令面板模糊过滤（纯函数）：子序列匹配 + 简明评分。
 *
 * 评分规则（分数越高越靠前）：
 * - 命中字符必须按顺序出现（子序列）；
 * - 连续命中奖励（+2/对）：前缀/词内连续段得分高；
 * - 词首命中奖励（+3）：camelCase 分词首字母或分隔符后首字符命中加分；
 * - 短标签奖励：命中密度（命中数/标签长度）。
 * 不命中返回 null（调用方过滤）。
 */

export interface PaletteItem<T> {
  /** 过滤目标（命令名/文件路径等）。 */
  label: string;
  /** 携带的任意负载（命令 id / 文件路径等）。 */
  payload: T;
}

export interface ScoredItem<T> extends PaletteItem<T> {
  score: number;
}

/** 词首字符判定：camelCase 大写、分隔符（/ - _ . 空格）之后。 */
function isWordStart(label: string, index: number): boolean {
  if (index === 0) return true;
  const prev = label[index - 1] ?? "";
  const curr = label[index] ?? "";
  if (/[a-z]/.test(prev) && /[A-Z]/.test(curr)) return true; // camelCase
  return /[/\-_. ]/.test(prev);
}

/** 单标签评分：不命中返回 null。 */
function scoreLabel(label: string, query: string): number | null {
  if (query === "") return 0;
  const lowerLabel = label.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let score = 0;
  let labelIdx = 0;
  let matched = 0;
  let prevHit = -2;
  for (let qi = 0; qi < lowerQuery.length; qi++) {
    const ch = lowerQuery[qi];
    if (ch === undefined || ch === " ") continue; // 空格仅分隔（宽松匹配）
    const hit = lowerLabel.indexOf(ch, labelIdx);
    if (hit < 0) return null;
    if (hit === prevHit + 1) score += 2; // 连续奖励
    if (isWordStart(label, hit)) score += 3; // 词首奖励
    score += 1; // 基础命中
    matched += 1;
    prevHit = hit;
    labelIdx = hit + 1;
  }
  // 命中密度：短而准的标签优先
  score += (matched / label.length) * 5;
  return score;
}

/** 过滤 + 排序（分数降序，同分保持注册序）。 */
export function filterPalette<T>(items: PaletteItem<T>[], query: string, limit = 20): ScoredItem<T>[] {
  const scored: ScoredItem<T>[] = [];
  for (const item of items) {
    const score = scoreLabel(item.label, query);
    if (score !== null) {
      scored.push({ ...item, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
