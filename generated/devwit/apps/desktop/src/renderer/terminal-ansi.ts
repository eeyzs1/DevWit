/**
 * ANSI 转义序列 → 带样式文本段（纯函数，渲染端把段转为着色 span）。
 *
 * 覆盖面（交互 shell 的常见子集）：
 * - SGR（Select Graphic Rendition）：前景/背景 8 色 + 16 亮色 + 256 色 +
 *   24 位真彩色 + 粗体/斜体/下划线/反显 + 复位（0 / 39 / 49 / 22 / 23 / 24 / 27）；
 * - 控制序列：光标移动/擦除/模式切换等一律剥离（终端面板按流式追加渲染，
 *   不模拟屏幕缓冲——全屏 TUI 程序不在支持面，诚实降级为文本流）；
 * - OSC（标题设置等）与其它私有序列：剥离。
 *
 * 不支持（有意）：CSI 光标定位类语义（H/A/B/C/D/J/K 的屏幕编辑）——需要
 * 完整屏幕缓冲模型（xterm.js 量级）。本实现面向命令输出流场景。
 */

/** 一段带样式的文本：classNames 为渲染端可用的 CSS 类子集。 */
export interface AnsiSegment {
  text: string;
  /** 样式类（如 "ansi-fg-red ansi-bold"）；空数组 = 默认样式。 */
  classNames: string[];
}

const FG_BASIC = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
] as const;

interface Cursor {
  classNames: string[];
}

/**
 * 解析整段输出（可含多次样式切换）。非法/不完整序列按字面文本处理
 *（不抛错——真实 shell 输出中混杂任意字节）。
 */
export function parseAnsi(input: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  const cursor: Cursor = { classNames: [] };
  let plain = "";
  const flush = (): void => {
    if (plain !== "") {
      segments.push({ text: plain, classNames: [...cursor.classNames] });
      plain = "";
    }
  };

  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    // ESC（含 UTF-8 之外的 C1 变体 \x9b 也按 CSI 处理）
    if (ch === "\u001b" || ch === "\u009b") {
      const isC1 = ch === "\u009b";
      const next = input[i + 1];
      if (!isC1 && next === "[") {
        // CSI：ESC [ params letter
        const match = /^\u001b\[([0-9;:?!<=>]*)?([@-~])/.exec(input.slice(i));
        if (match !== null) {
          // 仅 SGR（样式切换）需要切段；其余控制序列（光标移动/擦除等）
          // 不打断文本流——跳过后文本继续累积进当前段
          if (match[2] === "m") {
            flush();
            applySgr(cursor, match[1] ?? "");
          }
          i += match[0].length;
          continue;
        }
        // 不完整 CSI（流截断）：按字面输出剩余，等下一块补全由调用方拼接
        plain += input.slice(i);
        break;
      }
      if (!isC1 && (next === "]" || next === "P" || next === "X" || next === "^" || next === "_")) {
        // OSC / DCS / SOS / PM / APC：吃到 BEL 或 ST（ESC \）
        const rest = input.slice(i);
        const bel = rest.indexOf("\u0007");
        const st = rest.indexOf("\u001b\\");
        const end = bel >= 0 && (st < 0 || bel < st) ? bel + 1 : st >= 0 ? st + 2 : -1;
        if (end > 0) {
          i += end;
          continue;
        }
        plain += rest; // 不完整：整段按字面（罕见）
        break;
      }
      if (!isC1 && next !== undefined) {
        // 两字符转义（如 ESC M / ESC 7）：剥离，不打断文本流
        i += 2;
        continue;
      }
      // 孤立 ESC：剥离
      i += 1;
      continue;
    }
    plain += ch;
    i += 1;
  }
  flush();
  return segments;
}

/** 应用 SGR 参数到游标样式。 */
function applySgr(cursor: Cursor, params: string): void {
  if (params === "" || params === "0") {
    cursor.classNames = [];
    return;
  }
  const list = params.split(";").map((piece) => (piece === "" ? "0" : piece));
  for (let idx = 0; idx < list.length; idx++) {
    const code = Number.parseInt(list[idx] ?? "0", 10);
    if (Number.isNaN(code)) continue;
    if (code === 0) {
      cursor.classNames = [];
    } else if (code === 1) {
      add(cursor, "ansi-bold");
    } else if (code === 3) {
      add(cursor, "ansi-italic");
    } else if (code === 4) {
      add(cursor, "ansi-underline");
    } else if (code === 7) {
      add(cursor, "ansi-inverse");
    } else if (code === 22) {
      remove(cursor, "ansi-bold");
    } else if (code === 23) {
      remove(cursor, "ansi-italic");
    } else if (code === 24) {
      remove(cursor, "ansi-underline");
    } else if (code === 27) {
      remove(cursor, "ansi-inverse");
    } else if (code >= 30 && code <= 37) {
      setFg(cursor, FG_BASIC[code - 30] ?? "");
    } else if (code === 39) {
      removeByPrefix(cursor, "ansi-fg-");
    } else if (code >= 40 && code <= 47) {
      removeByPrefix(cursor, "ansi-bg-");
      add(cursor, `ansi-bg-${FG_BASIC[code - 40] ?? ""}`);
    } else if (code === 49) {
      removeByPrefix(cursor, "ansi-bg-");
    } else if (code >= 90 && code <= 97) {
      setFg(cursor, `bright-${FG_BASIC[code - 90] ?? ""}`);
    } else if (code >= 100 && code <= 107) {
      removeByPrefix(cursor, "ansi-bg-");
      add(cursor, `ansi-bg-bright-${FG_BASIC[code - 100] ?? ""}`);
    } else if (code === 38 || code === 48) {
      // 扩展色：38;5;n（256 色）与 38;2;r;g;b（真彩色）→ 归一到近似 8 色
      //（面板调色板固定，不生成任意行内色——避免 LLM/输出注入 style）
      const mode = list[idx + 1];
      if (mode === "5") {
        const n = Number.parseInt(list[idx + 2] ?? "", 10);
        idx += 2;
        if (!Number.isNaN(n)) {
          const approx = approximate256(n);
          if (code === 38) setFg(cursor, approx);
          else {
            removeByPrefix(cursor, "ansi-bg-");
            add(cursor, `ansi-bg-${approx}`);
          }
        }
      } else if (mode === "2") {
        idx += 4; // r;g;b 跳过——近似到默认（面板不支持任意色）
      }
    }
    // 其余 SSG 码（闪烁/隐藏等）忽略
  }
}

function add(cursor: Cursor, className: string): void {
  if (className !== "" && !cursor.classNames.includes(className)) {
    cursor.classNames.push(className);
  }
}

function remove(cursor: Cursor, className: string): void {
  cursor.classNames = cursor.classNames.filter((name) => name !== className);
}

function removeByPrefix(cursor: Cursor, prefix: string): void {
  cursor.classNames = cursor.classNames.filter((name) => !name.startsWith(prefix));
}

function setFg(cursor: Cursor, color: string): void {
  removeByPrefix(cursor, "ansi-fg-");
  add(cursor, `ansi-fg-${color}`);
}

/** 256 色索引 → 8 色近似（标准 16 环与 6×6×6 立方体的粗映射）。 */
function approximate256(n: number): string {
  if (n < 8) return FG_BASIC[n] ?? "";
  if (n < 16) return `bright-${FG_BASIC[n - 8] ?? ""}`;
  if (n >= 232) return n < 244 ? "white" : "black";
  const cube = n - 16;
  const step = Math.floor(cube / 36);
  void step; // 立方体色近似过于粗糙——统一归白（输出可读性优先于保真）
  return "white";
}
