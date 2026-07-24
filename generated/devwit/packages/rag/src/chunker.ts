import { createHash } from "node:crypto";

/**
 * 代码分块器（迭代 10 / AC19）。
 *
 * 策略：语法感知的启发式分块——
 * - 切分点：空行边界，或"顶级声明行"（无缩进且以声明关键字开头，如
 *   function/class/export/def/func 等，覆盖主流语言）；
 * - 块约束：≤ MAX_LINES 行且 ≤ MAX_CHARS 字符（任一超限即在最近边界闭合）；
 * - 防碎尾：末尾不足 MIN_LINES 的碎块并入前块（前块不因此超限两倍时）。
 *
 * chunkId = sha1(relPath:startLine:endLine:text) 前 16 位——内容稳定则 id 稳定
 * （跨 build 的逐项开关以此为准）；内容变化产生新 id，旧的逐项剔除自然失效，
 * 语义正确：用户剔除的是"那一段代码"，代码变了就是新的一段。
 */

export interface CodeChunk {
  /** 稳定标识（内容哈希），逐项开关的 key。 */
  id: string;
  relPath: string;
  startLine: number;
  endLine: number;
  text: string;
}

export const CHUNK_MAX_LINES = 80;
export const CHUNK_MAX_CHARS = 2400;
export const CHUNK_MIN_LINES = 3;

/** 顶级声明启发式：行首无空白 + 声明关键字（多语言并集）。 */
const TOP_LEVEL_DECL = /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var|def|func|fn|struct|impl|pub|package|import|from|#include|namespace|module|@|\w+\s*=\s*(?:async)?\s*(?:\(|function))/;

function isBoundaryLine(line: string): boolean {
  if (line.trim() === "") return true;
  if (/^\s/.test(line)) return false;
  return TOP_LEVEL_DECL.test(line);
}

export function makeChunkId(relPath: string, startLine: number, endLine: number, text: string): string {
  return createHash("sha1").update(`${relPath}:${startLine}:${endLine}\n${text}`).digest("hex").slice(0, 16);
}

/** 把单个源文件切成块。空文件/纯空白文件产出零块。 */
export function chunkSource(relPath: string, content: string): CodeChunk[] {
  const lines = content.split("\n");
  if (lines.every((line) => line.trim() === "")) return [];

  const chunks: CodeChunk[] = [];
  let bufStart = 1; // 1-based
  let buf: string[] = [];
  let bufChars = 0;

  const close = (endLine: number): void => {
    const text = buf.join("\n");
    if (text.trim() === "") {
      buf = [];
      bufChars = 0;
      return;
    }
    chunks.push({
      id: makeChunkId(relPath, bufStart, endLine, text),
      relPath,
      startLine: bufStart,
      endLine,
      text,
    });
    buf = [];
    bufChars = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i]!;
    const atBoundary = buf.length > 0 && isBoundaryLine(line);
    const overLines = buf.length >= CHUNK_MAX_LINES;
    const overChars = bufChars + line.length + 1 > CHUNK_MAX_CHARS;
    // 边界切分：积累块已达最小行数，遇到新边界即闭合；
    // 超限兜底：无论是否边界都闭合（宁可切断也不产出巨块）。
    if ((atBoundary && buf.length >= CHUNK_MIN_LINES) || overLines || (overChars && buf.length > 0)) {
      close(lineNo - 1);
      bufStart = lineNo;
    }
    buf.push(line);
    bufChars += line.length + 1;
  }
  close(lines.length);

  // 防碎尾：末块过碎且能并入前块（合并后仍在软限两倍内）则合并
  if (chunks.length >= 2) {
    const last = chunks[chunks.length - 1]!;
    const prev = chunks[chunks.length - 2]!;
    const lastLines = last.endLine - last.startLine + 1;
    const mergedText = `${prev.text}\n${last.text}`;
    if (lastLines < CHUNK_MIN_LINES && mergedText.length <= CHUNK_MAX_CHARS * 2) {
      const merged: CodeChunk = {
        id: makeChunkId(relPath, prev.startLine, last.endLine, mergedText),
        relPath,
        startLine: prev.startLine,
        endLine: last.endLine,
        text: mergedText,
      };
      chunks.splice(chunks.length - 2, 2, merged);
    }
  }
  return chunks;
}
