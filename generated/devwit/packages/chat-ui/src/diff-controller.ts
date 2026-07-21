import { diffLines } from "diff";

/**
 * 逐块接受/拒绝的行级 diff 控制器（WU013 / AC3）。
 *
 * 模型：original 与 proposal 经 jsdiff 行级 diff 得到变更段；
 * 连续的增/删行聚为一个 hunk（变更块），未变更行是 hunk 间的 context。
 * 每个 hunk 三态：pending（未审）→ accepted / rejected。
 * result() 合成最终文本：context 恒保留；accepted 用新增行；
 * rejected 与 pending（未审不默认应用）回退为原始行。
 */

export type DiffLineKind = "context" | "add" | "remove";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export type HunkDecision = "pending" | "accepted" | "rejected";

export interface DiffHunk {
  id: number;
  /** hunk 在合成序列中的起始行号（1 起始，供 UI 定位）。 */
  startLine: number;
  lines: DiffLine[];
  decision: HunkDecision;
}

/** 一个合成段：context 段或 hunk 段，按文档顺序排列。 */
export type DiffSegment = { kind: "context"; lines: string[] } | { kind: "hunk"; hunk: DiffHunk };

export interface DiffComputation {
  segments: DiffSegment[];
  hunks: DiffHunk[];
  /** 是否存在任何变更（false = 提案与原文一致，无需审查）。 */
  hasChanges: boolean;
}

/** 把 diff 的 value 拆成行（jsdiff 行级 value 以 \n 分隔，末行可能无 \n）。 */
function splitLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/** 计算 original → proposal 的行级 diff，产出 context/hunk 段序列。 */
export function computeDiff(original: string, proposal: string): DiffComputation {
  const changes = diffLines(original, proposal);
  const segments: DiffSegment[] = [];
  const hunks: DiffHunk[] = [];
  let pendingLines: DiffLine[] = [];
  let lineCursor = 1;

  const flushHunk = (): void => {
    if (pendingLines.length === 0) {
      return;
    }
    const hunk: DiffHunk = { id: hunks.length + 1, startLine: lineCursor, lines: pendingLines, decision: "pending" };
    // hunk 行号游标：合成序列中 remove 行（原文）与 add 行（新文）都占位展示
    lineCursor += pendingLines.length;
    hunks.push(hunk);
    segments.push({ kind: "hunk", hunk });
    pendingLines = [];
  };

  for (const change of changes) {
    const kind: DiffLineKind = change.added === true ? "add" : change.removed === true ? "remove" : "context";
    const lines = splitLines(change.value);
    if (kind === "context") {
      flushHunk();
      if (lines.length > 0) {
        segments.push({ kind: "context", lines });
        lineCursor += lines.length;
      }
    } else {
      for (const text of lines) {
        pendingLines.push({ kind, text });
      }
    }
  }
  flushHunk();

  return { segments, hunks, hasChanges: hunks.length > 0 };
}

/**
 * 按各 hunk 的裁决合成最终文本。
 * accepted → 取 add 行；rejected/pending → 取 remove 行（未审不默认应用，安全侧）。
 */
export function applyDecisions(computation: DiffComputation): string {
  const out: string[] = [];
  for (const segment of computation.segments) {
    if (segment.kind === "context") {
      out.push(...segment.lines);
      continue;
    }
    const hunk = segment.hunk;
    for (const line of hunk.lines) {
      if (line.kind === "add" && hunk.decision === "accepted") {
        out.push(line.text);
      } else if (line.kind === "remove" && hunk.decision !== "accepted") {
        out.push(line.text);
      }
    }
  }
  return out.join("\n");
}

/**
 * DiffController：持有一次 diff 的状态与裁决操作（供视图绑定）。
 * 纯逻辑，无 DOM——视图（diff-view.ts）订阅 onChange 重绘。
 */
export class DiffController {
  private readonly computation: DiffComputation;
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly original: string,
    readonly proposal: string
  ) {
    this.computation = computeDiff(original, proposal);
  }

  get segments(): DiffSegment[] {
    return this.computation.segments;
  }

  get hunks(): DiffHunk[] {
    return this.computation.hunks;
  }

  get hasChanges(): boolean {
    return this.computation.hasChanges;
  }

  /** 是否所有 hunk 均已裁决（可应用）。 */
  get allDecided(): boolean {
    return this.computation.hunks.every((hunk) => hunk.decision !== "pending");
  }

  accept(id: number): void {
    this.decide(id, "accepted");
  }

  reject(id: number): void {
    this.decide(id, "rejected");
  }

  acceptAll(): void {
    for (const hunk of this.computation.hunks) {
      hunk.decision = "accepted";
    }
    this.emit();
  }

  rejectAll(): void {
    for (const hunk of this.computation.hunks) {
      hunk.decision = "rejected";
    }
    this.emit();
  }

  /** 合成当前裁决下的最终文本。 */
  result(): string {
    return applyDecisions(this.computation);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private decide(id: number, decision: Exclude<HunkDecision, "pending">): void {
    const hunk = this.computation.hunks.find((entry) => entry.id === id);
    if (hunk === undefined) {
      return;
    }
    hunk.decision = decision;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
