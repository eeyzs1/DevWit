import type { Position, TextDocument } from "@devwit/editor-core";
import { ImeInput } from "./ime-input.js";
import {
  clampScrollTop,
  columnForX,
  comparePositions,
  isSelectionEmpty,
  normalizeSelection,
  visibleLineRange,
  xForColumn,
  type Measurer,
  type Selection,
} from "./layout.js";
import { defaultDarkTheme, type Theme } from "./theme.js";

/** 行级高亮 token 提供者（由 @devwit/syntax 的 HighlightEngine 实现，本包只依赖此结构）。 */
export interface HighlightTokenProvider {
  tokensForLine(line: number): Array<{ startChar: number; endChar: number; scope: string }>;
}

/** 一条诊断标记（LSP 0-based 行列；波浪线绘制，error 红 / warning 黄，info/hint 淡化）。 */
export interface DiagnosticRange {
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  severity: "error" | "warning" | "info" | "hint";
}

export interface EditorViewOptions {
  theme?: Theme;
  fontSize?: number;
  fontFamily?: string;
  lineHeight?: number;
  tabSize?: number;
  padding?: number;
}

/**
 * Canvas 自绘编辑器视图：绑定一个 HTMLCanvasElement 与一个 editor-core TextDocument。
 * 只渲染可视行（虚拟化），支持滚动、鼠标选区、多光标（Alt+Click）、IME 合成输入。
 * 代码智能（迭代 31 / AC40）：Ctrl/Cmd+Click 经 onDefinitionRequest 回调跳转定义，
 * 诊断经 setDiagnostics 注入并以波浪线绘制。
 * 坐标计算等纯逻辑全部委托 ./layout.js，本类只做 DOM 交互与绘制。
 */
export class EditorView {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private doc: TextDocument;
  private theme: Theme;
  private readonly fontSize: number;
  private readonly fontFamily: string;
  private readonly lineHeight: number;
  private readonly tabSize: number;
  private readonly padding: number;

  private readonly ime: ImeInput;
  private highlightProvider: HighlightTokenProvider | undefined;

  private docUnsubscribe: () => void;
  private scrollTop = 0;
  private scrollLeft = 0;
  private maxLineWidth = 0;
  private gutterWidth = 40;
  private selections: Selection[] = [{ anchor: { line: 0, character: 0 }, active: { line: 0, character: 0 } }];
  private dragging = false;
  private cursorVisible = true;
  private readonly blinkTimer: ReturnType<typeof setInterval>;
  private compositionText = "";
  private charWidth = 7;
  private readonly measurer: Measurer;
  private dpr = 1;
  private renderScheduled = false;
  private disposed = false;
  private readonly removeWindowListeners: Array<() => void> = [];
  /** 当前文档的诊断标记（setDiagnostics 注入；渲染为波浪线）。 */
  private diagnostics: DiagnosticRange[] = [];
  /** Ctrl/Cmd+Click 回调（跳转定义；由集成方接 LSP）。null 时该组合键等同普通点击。 */
  onDefinitionRequest: ((pos: Position) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, doc: TextDocument, options: EditorViewOptions = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      throw new Error("EditorView: failed to acquire 2d canvas context");
    }
    this.ctx = ctx;
    this.doc = doc;
    this.theme = options.theme ?? defaultDarkTheme;
    this.fontSize = options.fontSize ?? 14;
    this.fontFamily = options.fontFamily ?? 'Consolas, "Courier New", monospace';
    this.lineHeight = options.lineHeight ?? Math.round(this.fontSize * 1.45);
    this.tabSize = options.tabSize ?? 4;
    this.padding = options.padding ?? 4;

    this.applyFont();
    this.charWidth = this.measureCharWidth();
    this.measurer = (text) => text.length * this.charWidth;

    this.ime = new ImeInput({
      onCommitText: (text) => this.commitText(text),
      onCompositionStart: () => {
        this.compositionText = "";
        this.scheduleRender();
      },
      onCompositionUpdate: (text) => {
        this.compositionText = text;
        this.scheduleRender();
      },
      onCompositionEnd: (text) => {
        this.compositionText = "";
        if (text.length > 0) {
          this.replaceSelections(text);
        }
        this.scheduleRender();
      },
      onKeyDown: (ev) => this.onKeyDown(ev),
      onBlur: () => {
        this.cursorVisible = false;
        this.scheduleRender();
      },
      onFocus: () => {
        this.cursorVisible = true;
        this.scheduleRender();
      },
    }, canvas.parentElement ?? undefined);

    this.attachCanvasEvents();
    this.docUnsubscribe = this.doc.onDidChange(() => this.onDocumentChanged());
    this.blinkTimer = setInterval(() => {
      this.cursorVisible = !this.cursorVisible;
      this.scheduleRender();
    }, 530);

    this.resize();
  }

  // --------------------------------------------------------------------------
  // 公共 API
  // --------------------------------------------------------------------------

  get document(): TextDocument {
    return this.doc;
  }

  setDocument(doc: TextDocument): void {
    this.docUnsubscribe();
    this.doc = doc;
    this.docUnsubscribe = this.doc.onDidChange(() => this.onDocumentChanged());
    this.selections = [{ anchor: { line: 0, character: 0 }, active: { line: 0, character: 0 } }];
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.scheduleRender();
  }

  setHighlightProvider(provider: HighlightTokenProvider | undefined): void {
    this.highlightProvider = provider;
    this.scheduleRender();
  }

  /** 注入诊断标记（全量替换语义，与 LSP publishDiagnostics 一致）；波浪线随下次渲染绘制。 */
  setDiagnostics(ranges: DiagnosticRange[]): void {
    this.diagnostics = ranges;
    this.scheduleRender();
  }

  /** 浏览器客户区坐标 → 文档位置（悬停/跳转定义等外部交互的公共入口）。 */
  positionFromClientPoint(clientX: number, clientY: number): Position {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left + this.scrollLeft - this.gutterWidth;
    const y = clientY - rect.top + this.scrollTop - this.padding;
    const line = Math.max(0, Math.min(this.doc.lineCount - 1, Math.floor(y / this.lineHeight)));
    const character = columnForX(this.lineText(line), x, this.measurer);
    return { line, character };
  }

  /**
   * 文档位置 → 浏览器客户区坐标（positionFromClientPoint 的逆映射）：
   * 返回该字符格的水平起点与行垂直中心。自动完成补全浮层/e2e 精确定位共用。
   */
  clientPointForPosition(pos: Position): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const clamped = this.clampPosition(pos);
    const x = rect.left + this.gutterWidth + xForColumn(this.lineText(clamped.line), clamped.character, this.measurer) - this.scrollLeft;
    const y = rect.top + this.padding + clamped.line * this.lineHeight - this.scrollTop + this.lineHeight / 2;
    return { x, y };
  }

  /** 光标定位到指定位置并滚动至可见（跳转定义落点；折叠多光标为单光标）。 */
  revealPosition(pos: Position): void {
    const clamped = this.clampPosition(pos);
    this.selections = [{ anchor: clamped, active: clamped }];
    this.wakeCursor();
    this.ensureCursorVisible();
    this.scheduleRender();
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.scheduleRender();
  }

  getSelections(): Selection[] {
    return this.selections.map((sel) => ({ anchor: { ...sel.anchor }, active: { ...sel.active } }));
  }

  focus(): void {
    this.ime.focus();
  }

  /** 按 canvas 的 CSS 尺寸重设后备缓冲（devicePixelRatio 感知）。尺寸变化时由集成方调用。 */
  resize(): void {
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    const cssWidth = this.canvas.clientWidth || this.canvas.width || 800;
    const cssHeight = this.canvas.clientHeight || this.canvas.height || 600;
    this.canvas.width = Math.round(cssWidth * this.dpr);
    this.canvas.height = Math.round(cssHeight * this.dpr);
    this.scheduleRender();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    clearInterval(this.blinkTimer);
    this.docUnsubscribe();
    for (const off of this.removeWindowListeners) {
      off();
    }
    this.ime.dispose();
  }

  // --------------------------------------------------------------------------
  // 事件绑定
  // --------------------------------------------------------------------------

  private attachCanvasEvents(): void {
    this.canvas.addEventListener("mousedown", (ev) => this.onMouseDown(ev));
    this.canvas.addEventListener("wheel", (ev) => this.onWheel(ev), { passive: false });
    this.canvas.addEventListener("dblclick", (ev) => this.onDoubleClick(ev));
    const move = (ev: MouseEvent): void => this.onMouseMove(ev);
    const up = (): void => {
      this.dragging = false;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    this.removeWindowListeners.push(() => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    });
  }

  private onMouseDown(ev: MouseEvent): void {
    if (ev.button !== 0) {
      return;
    }
    this.ime.focus();
    const pos = this.positionFromEvent(ev);
    this.wakeCursor();
    if (ev.shiftKey) {
      // 扩展主选区
      const primary = this.primarySelection();
      primary.active = pos;
    } else if (ev.altKey) {
      // 添加光标（VS Code 惯例：Alt+Click 多光标，Ctrl/Cmd+Click 跳转定义）
      const exists = this.selections.some((sel) => comparePositions(sel.active, pos) === 0);
      if (!exists) {
        this.selections.push({ anchor: pos, active: pos });
      }
    } else {
      this.selections = [{ anchor: pos, active: pos }];
      if ((ev.ctrlKey || ev.metaKey) && this.onDefinitionRequest !== null) {
        // 跳转定义：光标先落定（用户可见反馈），目标解析由集成方异步完成
        this.onDefinitionRequest(pos);
      }
    }
    this.dragging = true;
    this.ensureCursorVisible();
    this.scheduleRender();
    ev.preventDefault();
  }

  private onMouseMove(ev: MouseEvent): void {
    if (!this.dragging) {
      return;
    }
    const pos = this.positionFromEvent(ev);
    this.primarySelection().active = pos;
    this.ensureCursorVisible();
    this.scheduleRender();
  }

  private onDoubleClick(ev: MouseEvent): void {
    // 双击选词：向两侧扩展非词字符边界
    const pos = this.positionFromEvent(ev);
    const lineText = this.lineText(pos.line);
    const isWord = (ch: string): boolean => /[\w]/.test(ch);
    let start = Math.min(pos.character, lineText.length);
    let end = start;
    while (start > 0 && isWord(lineText.charAt(start - 1))) {
      start -= 1;
    }
    while (end < lineText.length && isWord(lineText.charAt(end))) {
      end += 1;
    }
    if (start < end) {
      this.selections = [{ anchor: { line: pos.line, character: start }, active: { line: pos.line, character: end } }];
      this.scheduleRender();
    }
    ev.preventDefault();
  }

  private onWheel(ev: WheelEvent): void {
    ev.preventDefault();
    if (ev.shiftKey) {
      this.scrollLeft += ev.deltaY + ev.deltaX;
    } else {
      this.scrollTop += ev.deltaY;
      this.scrollLeft += ev.deltaX;
    }
    this.clampScroll();
    this.scheduleRender();
  }

  private onKeyDown(ev: KeyboardEvent): void {
    const mod = ev.ctrlKey || ev.metaKey;
    const key = ev.key;
    const lower = key.length === 1 ? key.toLowerCase() : key;

    if (mod) {
      switch (lower) {
        case "z":
          if (ev.shiftKey) {
            this.doc.redo();
          } else {
            this.doc.undo();
          }
          this.clampSelections();
          ev.preventDefault();
          return;
        case "y":
          this.doc.redo();
          this.clampSelections();
          ev.preventDefault();
          return;
        case "a":
          this.selectAll();
          ev.preventDefault();
          return;
        case "c":
          this.copySelectionToClipboard();
          ev.preventDefault();
          return;
        case "x":
          this.copySelectionToClipboard();
          this.replaceSelections("");
          ev.preventDefault();
          return;
        case "Home":
          this.moveCursorsTo({ line: 0, character: 0 }, ev.shiftKey);
          ev.preventDefault();
          return;
        case "End": {
          const lastLine = this.doc.lineCount - 1;
          this.moveCursorsTo({ line: lastLine, character: this.lineText(lastLine).length }, ev.shiftKey);
          ev.preventDefault();
          return;
        }
        default:
          return; // Ctrl+V 等交给隐藏 textarea 原生行为（paste → input 事件）
      }
    }

    switch (key) {
      case "Backspace":
        this.backspace();
        ev.preventDefault();
        break;
      case "Delete":
        this.deleteForward();
        ev.preventDefault();
        break;
      case "Enter":
        this.replaceSelections("\n");
        ev.preventDefault();
        break;
      case "Tab":
        this.replaceSelections(" ".repeat(this.tabSize));
        ev.preventDefault();
        break;
      case "Escape":
        if (this.compositionText.length === 0 && this.selections.length > 1) {
          this.selections = [this.primarySelection()];
          this.scheduleRender();
        }
        break;
      case "ArrowLeft":
        this.moveCursorsHorizontal(-1, ev.shiftKey);
        ev.preventDefault();
        break;
      case "ArrowRight":
        this.moveCursorsHorizontal(1, ev.shiftKey);
        ev.preventDefault();
        break;
      case "ArrowUp":
        this.moveCursorsVertical(-1, ev.shiftKey);
        ev.preventDefault();
        break;
      case "ArrowDown":
        this.moveCursorsVertical(1, ev.shiftKey);
        ev.preventDefault();
        break;
      case "Home":
        this.moveCursorsHomeEnd(true, ev.shiftKey);
        ev.preventDefault();
        break;
      case "End":
        this.moveCursorsHomeEnd(false, ev.shiftKey);
        ev.preventDefault();
        break;
      case "PageUp":
        this.moveCursorsVertical(-this.visiblePageLines(), ev.shiftKey);
        ev.preventDefault();
        break;
      case "PageDown":
        this.moveCursorsVertical(this.visiblePageLines(), ev.shiftKey);
        ev.preventDefault();
        break;
      default:
        break; // 可打印字符由 input / IME 事件进入
    }
  }

  // --------------------------------------------------------------------------
  // 编辑操作
  // --------------------------------------------------------------------------

  private commitText(text: string): void {
    this.replaceSelections(text);
  }

  /** 用 text 替换每个选区（空选区即插入）。自底向上应用保证偏移不失效。 */
  private replaceSelections(text: string): void {
    interface Sel {
      startOffset: number;
      endOffset: number;
      index: number;
    }
    const sels: Sel[] = this.selections.map((sel, index) => {
      const norm = normalizeSelection(sel);
      return {
        startOffset: this.doc.offsetAt(norm.start),
        endOffset: this.doc.offsetAt(norm.end),
        index,
      };
    });
    // 每个选区的最终偏移 = startOffset + text.length + 所有更低选区的长度增量之和。
    // 先升序预累计增量，再降序应用编辑（降序保证未应用的低位偏移不失效）。
    const asc = [...sels].sort((a, b) => a.startOffset - b.startOffset);
    const shiftByIndex: number[] = new Array<number>(sels.length).fill(0);
    let shift = 0;
    for (const sel of asc) {
      shiftByIndex[sel.index] = shift;
      shift += text.length - (sel.endOffset - sel.startOffset);
    }
    const desc = [...sels].sort((a, b) => b.startOffset - a.startOffset);
    const newOffsets: number[] = new Array<number>(sels.length);
    for (const sel of desc) {
      this.doc.applyEdit({ offset: sel.startOffset, length: sel.endOffset - sel.startOffset, text });
      newOffsets[sel.index] = sel.startOffset + text.length + (shiftByIndex[sel.index] ?? 0);
    }
    this.selections = this.selections.map((_, index) => {
      const pos = this.doc.positionAt(newOffsets[index] ?? 0);
      return { anchor: pos, active: pos };
    });
    this.wakeCursor();
    this.ensureCursorVisible();
    this.scheduleRender();
  }

  private backspace(): void {
    if (this.selections.some((sel) => !isSelectionEmpty(sel))) {
      this.replaceSelections("");
      return;
    }
    const offsets = this.selections.map((sel) => this.doc.offsetAt(sel.active));
    const desc = offsets.map((offset, index) => ({ offset, index })).sort((a, b) => b.offset - a.offset);
    const newOffsets: number[] = new Array<number>(offsets.length);
    for (const { offset, index } of desc) {
      if (offset > 0) {
        this.doc.applyEdit({ offset: offset - 1, length: 1, text: "" });
        // 最终偏移 = offset - 1 -（更低处实际删除的光标数）；降序应用保证低位偏移有效
        const below = offsets.filter((o) => o > 0 && o < offset).length;
        newOffsets[index] = offset - 1 - below;
      } else {
        newOffsets[index] = 0;
      }
    }
    this.selections = this.selections.map((_, index) => {
      const pos = this.doc.positionAt(newOffsets[index] ?? 0);
      return { anchor: pos, active: pos };
    });
    this.wakeCursor();
    this.ensureCursorVisible();
    this.scheduleRender();
  }

  private deleteForward(): void {
    if (this.selections.some((sel) => !isSelectionEmpty(sel))) {
      this.replaceSelections("");
      return;
    }
    const total = this.doc.length;
    const offsets = this.selections.map((sel) => this.doc.offsetAt(sel.active));
    const desc = offsets.map((offset, index) => ({ offset, index })).sort((a, b) => b.offset - a.offset);
    const newOffsets: number[] = new Array<number>(offsets.length);
    for (const { offset, index } of desc) {
      if (offset < total) {
        this.doc.applyEdit({ offset, length: 1, text: "" });
      }
      const below = offsets.filter((o) => o < offset).length;
      newOffsets[index] = offset - below;
    }
    this.selections = this.selections.map((_, index) => {
      const pos = this.doc.positionAt(newOffsets[index] ?? 0);
      return { anchor: pos, active: pos };
    });
    this.wakeCursor();
    this.ensureCursorVisible();
    this.scheduleRender();
  }

  // --------------------------------------------------------------------------
  // 光标移动与选区
  // --------------------------------------------------------------------------

  private primarySelection(): Selection {
    const primary = this.selections[this.selections.length - 1];
    if (primary === undefined) {
      const sel: Selection = { anchor: { line: 0, character: 0 }, active: { line: 0, character: 0 } };
      this.selections.push(sel);
      return sel;
    }
    return primary;
  }

  private moveCursorsHorizontal(delta: -1 | 1, extend: boolean): void {
    this.selections = this.selections.map((sel) => {
      if (!extend && !isSelectionEmpty(sel)) {
        // 非扩展移动：折叠到选区边缘
        const norm = normalizeSelection(sel);
        const pos = delta < 0 ? norm.start : norm.end;
        return { anchor: pos, active: pos };
      }
      const offset = this.doc.offsetAt(sel.active);
      const next = this.doc.positionAt(Math.max(0, Math.min(this.doc.length, offset + delta)));
      return extend ? { anchor: sel.anchor, active: next } : { anchor: next, active: next };
    });
    this.wakeCursor();
    this.ensureCursorVisible();
    this.scheduleRender();
  }

  private moveCursorsVertical(lineDelta: number, extend: boolean): void {
    this.selections = this.selections.map((sel) => {
      const targetLine = Math.max(0, Math.min(this.doc.lineCount - 1, sel.active.line + lineDelta));
      const targetChar = Math.min(sel.active.character, this.lineText(targetLine).length);
      const next: Position = { line: targetLine, character: targetChar };
      return extend ? { anchor: sel.anchor, active: next } : { anchor: next, active: next };
    });
    this.wakeCursor();
    this.ensureCursorVisible();
    this.scheduleRender();
  }

  private moveCursorsHomeEnd(home: boolean, extend: boolean): void {
    this.selections = this.selections.map((sel) => {
      const char = home ? 0 : this.lineText(sel.active.line).length;
      const next: Position = { line: sel.active.line, character: char };
      return extend ? { anchor: sel.anchor, active: next } : { anchor: next, active: next };
    });
    this.wakeCursor();
    this.ensureCursorVisible();
    this.scheduleRender();
  }

  private moveCursorsTo(pos: Position, extend: boolean): void {
    this.selections = this.selections.map((sel) =>
      extend ? { anchor: sel.anchor, active: pos } : { anchor: pos, active: pos }
    );
    this.wakeCursor();
    this.ensureCursorVisible();
    this.scheduleRender();
  }

  private selectAll(): void {
    const lastLine = this.doc.lineCount - 1;
    this.selections = [
      {
        anchor: { line: 0, character: 0 },
        active: { line: lastLine, character: this.lineText(lastLine).length },
      },
    ];
    this.scheduleRender();
  }

  private selectedText(): string {
    const parts: string[] = [];
    for (const sel of this.selections) {
      if (isSelectionEmpty(sel)) {
        continue;
      }
      const norm = normalizeSelection(sel);
      parts.push(this.doc.getTextInRange(this.doc.offsetAt(norm.start), this.doc.offsetAt(norm.end)));
    }
    return parts.join("\n");
  }

  private copySelectionToClipboard(): void {
    const text = this.selectedText();
    if (text.length === 0) {
      return;
    }
    // 渲染进程剪贴板权限可能未授予：写入失败时静默（不影响编辑功能）
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  }

  private clampSelections(): void {
    this.selections = this.selections.map((sel) => ({
      anchor: this.clampPosition(sel.anchor),
      active: this.clampPosition(sel.active),
    }));
  }

  private clampPosition(pos: Position): Position {
    const line = Math.max(0, Math.min(pos.line, this.doc.lineCount - 1));
    const character = Math.max(0, Math.min(pos.character, this.lineText(line).length));
    return { line, character };
  }

  // --------------------------------------------------------------------------
  // 坐标换算与滚动
  // --------------------------------------------------------------------------

  private lineText(line: number): string {
    if (line < 0 || line >= this.doc.lineCount) {
      return "";
    }
    return this.doc.getLine(line);
  }

  private positionFromEvent(ev: MouseEvent): Position {
    const rect = this.canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left + this.scrollLeft - this.gutterWidth;
    const y = ev.clientY - rect.top + this.scrollTop - this.padding;
    const line = Math.max(0, Math.min(this.doc.lineCount - 1, Math.floor(y / this.lineHeight)));
    const character = columnForX(this.lineText(line), x, this.measurer);
    return { line, character };
  }

  private visiblePageLines(): number {
    return Math.max(1, Math.floor(this.viewportHeight() / this.lineHeight) - 1);
  }

  private viewportHeight(): number {
    return this.canvas.height / this.dpr;
  }

  private viewportWidth(): number {
    return this.canvas.width / this.dpr;
  }

  private clampScroll(): void {
    this.scrollTop = clampScrollTop(this.scrollTop, this.doc.lineCount, this.lineHeight, this.viewportHeight());
    const maxLeft = Math.max(0, this.gutterWidth + this.maxLineWidth + 40 - this.viewportWidth());
    this.scrollLeft = Math.max(0, Math.min(this.scrollLeft, maxLeft));
  }

  private ensureCursorVisible(): void {
    const active = this.primarySelection().active;
    const y = this.padding + active.line * this.lineHeight;
    const viewH = this.viewportHeight();
    if (y < this.scrollTop) {
      this.scrollTop = y;
    } else if (y + this.lineHeight > this.scrollTop + viewH) {
      this.scrollTop = y + this.lineHeight - viewH;
    }
    const x = xForColumn(this.lineText(active.line), active.character, this.measurer);
    const viewW = this.viewportWidth() - this.gutterWidth;
    if (x < this.scrollLeft) {
      this.scrollLeft = x;
    } else if (x > this.scrollLeft + viewW) {
      this.scrollLeft = x - viewW;
    }
    this.clampScroll();
  }

  private onDocumentChanged(): void {
    this.clampSelections();
    this.clampScroll();
    this.scheduleRender();
  }

  private wakeCursor(): void {
    this.cursorVisible = true;
  }

  // --------------------------------------------------------------------------
  // 渲染
  // --------------------------------------------------------------------------

  private applyFont(): void {
    this.ctx.font = `${this.fontSize}px ${this.fontFamily}`;
    this.ctx.textBaseline = "middle";
  }

  /** 用一组代表性字符测得等宽字宽（measureText 一次性采样）。 */
  private measureCharWidth(): number {
    const sample = "MMMMMMMMMMxxxxxxxxxX0123456789";
    const width = this.ctx.measureText(sample).width;
    return width > 0 ? width / sample.length : 7;
  }

  private scheduleRender(): void {
    if (this.disposed || this.renderScheduled) {
      return;
    }
    this.renderScheduled = true;
    requestAnimationFrame(() => this.render());
  }

  private render(): void {
    this.renderScheduled = false;
    if (this.disposed) {
      return;
    }
    const ctx = this.ctx;
    const viewW = this.viewportWidth();
    const viewH = this.viewportHeight();

    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    this.applyFont();

    // 行号槽宽：按行数位数自适应
    const digits = Math.max(2, String(this.doc.lineCount).length);
    this.gutterWidth = Math.ceil(digits * this.charWidth + 16);

    // 背景
    ctx.fillStyle = this.theme.background;
    ctx.fillRect(0, 0, viewW, viewH);

    const range = visibleLineRange(this.scrollTop, viewH, this.lineHeight, this.doc.lineCount);
    const primaryLine = this.primarySelection().active.line;

    // 当前行高亮
    if (primaryLine >= range.first && primaryLine <= range.last) {
      const y = this.padding + primaryLine * this.lineHeight - this.scrollTop;
      ctx.fillStyle = this.theme.currentLineBackground;
      ctx.fillRect(this.gutterWidth, y, viewW - this.gutterWidth, this.lineHeight);
    }

    // 可视行：选区 → 文本
    this.maxLineWidth = 0;
    for (let line = range.first; line <= range.last; line++) {
      const y = this.padding + line * this.lineHeight - this.scrollTop;
      this.renderSelectionOnLine(line, y, viewW);
    }
    for (let line = range.first; line <= range.last; line++) {
      const y = this.padding + line * this.lineHeight - this.scrollTop;
      this.renderLineText(line, y);
    }

    // 诊断波浪线（文本之上、光标之下；只画可视行相交段）
    this.renderDiagnostics(range.first, range.last);

    // IME 合成串（画在主光标处，带下划线）
    if (this.compositionText.length > 0) {
      this.renderComposition();
    }

    // 光标
    if (this.cursorVisible) {
      this.renderCursors();
    }

    // 行号槽
    ctx.fillStyle = this.theme.gutterBackground;
    ctx.fillRect(0, 0, this.gutterWidth, viewH);
    ctx.fillStyle = this.theme.lineNumberForeground;
    ctx.textAlign = "right";
    for (let line = range.first; line <= range.last; line++) {
      const y = this.padding + line * this.lineHeight - this.scrollTop;
      ctx.fillText(String(line + 1), this.gutterWidth - 8, y + this.lineHeight / 2);
    }
    ctx.textAlign = "left";

    ctx.restore();

    // IME 候选窗定位到主光标
    const active = this.primarySelection().active;
    const cursorX = this.gutterWidth + xForColumn(this.lineText(active.line), active.character, this.measurer) - this.scrollLeft;
    const cursorY = this.padding + active.line * this.lineHeight - this.scrollTop;
    const rect = this.canvas.getBoundingClientRect();
    this.ime.setPosition(rect.left + cursorX, rect.top + cursorY);
  }

  private renderSelectionOnLine(line: number, y: number, viewW: number): void {
    const lineText = this.lineText(line);
    for (const sel of this.selections) {
      if (isSelectionEmpty(sel)) {
        continue;
      }
      const norm = normalizeSelection(sel);
      if (norm.end.line < line || norm.start.line > line) {
        continue;
      }
      const startChar = norm.start.line === line ? norm.start.character : 0;
      const continuesPastLine = norm.end.line > line;
      const endChar = continuesPastLine ? lineText.length : norm.end.character;
      const x1 = xForColumn(lineText, startChar, this.measurer);
      let x2 = xForColumn(lineText, endChar, this.measurer);
      if (continuesPastLine) {
        x2 += this.charWidth; // 行尾换行被选中的视觉尾巴
      }
      const screenX = this.gutterWidth + x1 - this.scrollLeft;
      ctx_fill(this.ctx, this.theme.selectionBackground, screenX, y, Math.max(2, x2 - x1), this.lineHeight, viewW);
    }
  }

  private renderLineText(line: number, y: number): void {
    const ctx = this.ctx;
    const lineText = this.lineText(line);
    this.maxLineWidth = Math.max(this.maxLineWidth, lineText.length * this.charWidth);
    const originX = this.gutterWidth - this.scrollLeft;
    const midY = y + this.lineHeight / 2;

    const tokens = this.highlightProvider?.tokensForLine(line) ?? [];
    if (tokens.length === 0) {
      ctx.fillStyle = this.theme.foreground;
      ctx.fillText(lineText, originX, midY);
      return;
    }

    // 按 token 分段着色，缝隙用前景色
    let cursor = 0;
    for (const token of tokens) {
      const start = Math.max(0, Math.min(token.startChar, lineText.length));
      const end = Math.max(start, Math.min(token.endChar, lineText.length));
      if (start > cursor) {
        ctx.fillStyle = this.theme.foreground;
        ctx.fillText(lineText.slice(cursor, start), originX + cursor * this.charWidth, midY);
      }
      if (end > start) {
        ctx.fillStyle = this.theme.scopes[token.scope] ?? this.theme.foreground;
        ctx.fillText(lineText.slice(start, end), originX + start * this.charWidth, midY);
        cursor = end;
      }
    }
    if (cursor < lineText.length) {
      ctx.fillStyle = this.theme.foreground;
      ctx.fillText(lineText.slice(cursor), originX + cursor * this.charWidth, midY);
    }
  }

  private renderComposition(): void {
    const ctx = this.ctx;
    const active = this.primarySelection().active;
    const lineText = this.lineText(active.line);
    const x = this.gutterWidth + xForColumn(lineText, active.character, this.measurer) - this.scrollLeft;
    const y = this.padding + active.line * this.lineHeight - this.scrollTop;
    const width = this.compositionText.length * this.charWidth;
    ctx.fillStyle = this.theme.compositionForeground;
    ctx.fillText(this.compositionText, x, y + this.lineHeight / 2);
    ctx.fillStyle = this.theme.compositionUnderline;
    ctx.fillRect(x, y + this.lineHeight - 2, width, 1);
  }

  /** 诊断波浪线：逐可视行求交段，正弦波 path 绘制（error 红 / warning 黄 / info·hint 灰）。 */
  private renderDiagnostics(firstLine: number, lastLine: number): void {
    if (this.diagnostics.length === 0) {
      return;
    }
    for (const diag of this.diagnostics) {
      if (diag.endLine < firstLine || diag.line > lastLine) {
        continue;
      }
      const color =
        diag.severity === "error"
          ? this.theme.diagnosticError
          : diag.severity === "warning"
            ? this.theme.diagnosticWarning
            : this.theme.lineNumberForeground;
      for (let line = Math.max(diag.line, firstLine); line <= Math.min(diag.endLine, lastLine); line++) {
        const lineText = this.lineText(line);
        const startChar = line === diag.line ? Math.min(diag.character, lineText.length) : 0;
        // 跨行诊断的中间行/末行：末行取 endCharacter，中间行取整行；空段退化为单字符宽
        const endChar = line === diag.endLine ? Math.min(diag.endCharacter, lineText.length) : lineText.length;
        const x1 = this.gutterWidth + xForColumn(lineText, startChar, this.measurer) - this.scrollLeft;
        const width = Math.max(xForColumn(lineText, endChar, this.measurer) - xForColumn(lineText, startChar, this.measurer), this.charWidth);
        const baseY = this.padding + line * this.lineHeight - this.scrollTop + this.lineHeight - 3;
        this.strokeSquiggle(x1, baseY, width, color);
      }
    }
  }

  /** 单个波浪线段（振幅 1.5px、周期 4px 的三角波近似，性能优于正弦采样）。 */
  private strokeSquiggle(x: number, baseY: number, width: number, color: string): void {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const startX = Math.round(x) + 0.5; // 半像素对齐防模糊
    const endX = startX + width;
    let up = true;
    ctx.moveTo(startX, baseY);
    for (let px = startX + 2; px < endX; px += 2) {
      ctx.lineTo(px, up ? baseY - 1.5 : baseY + 1);
      up = !up;
    }
    ctx.lineTo(endX, baseY);
    ctx.stroke();
  }

  private renderCursors(): void {
    const ctx = this.ctx;
    ctx.fillStyle = this.theme.cursor;
    for (const sel of this.selections) {
      const active = sel.active;
      const x = this.gutterWidth + xForColumn(this.lineText(active.line), active.character, this.measurer) - this.scrollLeft;
      const y = this.padding + active.line * this.lineHeight - this.scrollTop;
      if (y + this.lineHeight < 0 || y > this.viewportHeight()) {
        continue;
      }
      ctx.fillRect(Math.round(x), y, 2, this.lineHeight);
    }
  }
}

function ctx_fill(
  ctx: CanvasRenderingContext2D,
  color: string,
  x: number,
  y: number,
  width: number,
  height: number,
  clipWidth: number
): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, Math.min(width, Math.max(0, clipWidth - x)), height);
}
