import type { Position, TextDocument } from "@devwit/editor-core";
import { ImeInput } from "./ime-input.js";
import {
  clampScrollTop,
  columnForX,
  comparePositions,
  computeAutoIndent,
  computeAutoPair,
  computeFoldRegions,
  findMatchingBracket,
  indentLevelOf,
  isSelectionEmpty,
  minimapLayout,
  normalizeSelection,
  outdentLine,
  visibleLineRange,
  xForColumn,
  type FoldRegion,
  type Measurer,
  type Selection,
} from "./layout.js";
import { defaultDarkTheme, type Theme } from "./theme.js";

/**
 * 断点视觉类型（v0.4.0）。
 * - normal：普通断点，行号槽红实心圆。
 * - conditional：条件/命中次数断点，黄空心环 + 中心实心点（提示"有附加条件"）。
 * - log：日志断点，青菱形（与暂停断点视觉区分——不暂停）。
 */
export type BreakpointKind = "normal" | "conditional" | "log";

/** 自动配对的开括号 → 闭括号（单字符非合成输入触发；粘贴/IME 不触发）。 */
const AUTO_PAIR_CLOSE: Record<string, string> = {
  "(": ")",
  "[": "]",
  "{": "}",
};

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
  minimapEnabled?: boolean;
  minimapWidth?: number;
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
  /** 渲染期间生效的可视行映射（docLine → screenIndex）；render 外为空。 */
  private visibleLineMap: Map<number, number> = new Map();
  /** 当前文档的诊断标记（setDiagnostics 注入；渲染为波浪线）。 */
  private diagnostics: DiagnosticRange[] = [];
  /**
   * 断点条目（0-based 行 → 类型；setBreakpoints 注入；行号槽按类型绘制不同形状）。
   * 类型：normal=红实心圆；conditional=黄空心环 + 中心点；log=青菱形。
   */
  private breakpointEntries: ReadonlyMap<number, BreakpointKind> = new Map();
  /** 调试停止行（0-based；null=无；整行底色 + 行号槽箭头）。 */
  private debugLine: number | null = null;
  /** 行注释前缀（Ctrl+/ 切换；默认 "//"，集成方按文件类型 setLineComment 设置）。 */
  private lineComment = "//";
  /** 可折叠区域列表（由集成方注入或自动按缩进计算；render 时在行号槽绘制折叠标记）。 */
  private foldRegions: FoldRegion[] = [];
  /** 已折叠的起始行集合（0-based startLine → true；render 时跳过 startLine+1..endLine）。 */
  private foldedStarts: Set<number> = new Set();
  /** Minimap 缩略图开关（v0.5.0：右侧缩略渲染 + 视口指示框 + 点击/拖拽滚动）。 */
  private minimapEnabled: boolean;
  /** Minimap 宽度（像素；默认 80）。 */
  private minimapWidth: number;
  /** Minimap 每行高度（像素；默认 max(2, floor(lineHeight/4))）。 */
  private readonly minimapLineHeight: number;
  /** Minimap 拖拽中标记（onMouseDown 命中 minimap 时置 true，mouseup 清除）。 */
  private minimapDragging = false;
  /** 渲染期间填充的可视行有序数组（screenIdx → docLine；折叠隐藏行已跳过）。 */
  private renderVisibleLines: number[] = [];
  /** Ctrl/Cmd+Click 回调（跳转定义；由集成方接 LSP）。null 时该组合键等同普通点击。 */
  onDefinitionRequest: ((pos: Position) => void) | null = null;
  /** 行号槽点击回调（断点切换；由集成方接 DAP）。null 时槽点击等同普通点击。 */
  onGutterClick: ((line: number) => void) | null = null;
  /**
   * 行号槽右键回调（v0.4.0：编辑断点 condition/hitCount/logMessage）。
   * null 时右键不触发编辑（保持仅左键切换的原行为）。
   */
  onGutterContextMenu: ((line: number) => void) | null = null;

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
    this.minimapEnabled = options.minimapEnabled ?? false;
    this.minimapWidth = options.minimapWidth ?? 80;
    this.minimapLineHeight = Math.max(2, Math.floor(this.lineHeight / 4));

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
    this.foldedStarts.clear();
    this.recomputeFoldRegions();
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

  /**
   * 注入断点条目（0-based 行 → 类型，全量替换语义）；按类型在行号槽绘制不同形状。
   * 全空 Map = 清除当前文件全部断点。
   */
  setBreakpoints(entries: ReadonlyMap<number, BreakpointKind>): void {
    this.breakpointEntries = entries;
    this.scheduleRender();
  }

  /** 设置调试停止行（0-based；null 清除）；高亮随下次渲染绘制。 */
  setDebugLine(line: number | null): void {
    this.debugLine = line;
    this.scheduleRender();
  }

  /** 浏览器客户区坐标 → 文档位置（悬停/跳转定义等外部交互的公共入口）。 */
  positionFromClientPoint(clientX: number, clientY: number): Position {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left + this.scrollLeft - this.gutterWidth;
    const y = clientY - rect.top + this.scrollTop - this.padding;
    const line = this.docLineFromScreenY(y);
    const character = columnForX(this.lineText(line), x, this.measurer);
    return { line, character };
  }

  /** screenY → docLine（跳过折叠隐藏行；越界收敛到末行）。 */
  private docLineFromScreenY(screenY: number): number {
    const screenIdx = Math.max(0, Math.floor(screenY / this.lineHeight));
    // 构建 visibleLines（如果 render 未填充则现场构建）
    let docLine = -1;
    if (this.visibleLineMap.size > 0) {
      // 渲染期间已有映射，但 Map 是 docLine→screenIdx，需反向查找
      for (const [dl, si] of this.visibleLineMap) {
        if (si === screenIdx) { docLine = dl; break; }
      }
    }
    if (docLine < 0) {
      // 现场构建（非渲染期间：positionFromClientPoint 等外部调用）
      let idx = 0;
      for (let line = 0; line < this.doc.lineCount; line++) {
        if (this.isLineHidden(line)) continue;
        if (idx === screenIdx) { docLine = line; break; }
        idx++;
      }
      if (docLine < 0) {
        // 超过末行 → 最后一可见行
        for (let line = this.doc.lineCount - 1; line >= 0; line--) {
          if (!this.isLineHidden(line)) { docLine = line; break; }
        }
      }
    }
    return Math.max(0, docLine);
  }

  /**
   * 文档位置 → 浏览器客户区坐标（positionFromClientPoint 的逆映射）：
   * 返回该字符格的水平起点与行垂直中心。自动完成补全浮层/e2e 精确定位共用。
   */
  clientPointForPosition(pos: Position): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const clamped = this.clampPosition(pos);
    const x = rect.left + this.gutterWidth + xForColumn(this.lineText(clamped.line), clamped.character, this.measurer) - this.scrollLeft;
    // screenY: 用 visibleLineMap 查找，否则退化为直接映射
    let screenIdx = this.visibleLineMap.get(clamped.line);
    if (screenIdx === undefined) {
      // 非渲染期间现场计算
      screenIdx = 0;
      for (let line = 0; line < clamped.line; line++) {
        if (!this.isLineHidden(line)) screenIdx++;
      }
    }
    const y = rect.top + this.padding + screenIdx * this.lineHeight - this.scrollTop + this.lineHeight / 2;
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

  /** 设置行注释前缀（Ctrl+/ 切换用；按文件类型设 "//" / "#" / ";" 等）。 */
  setLineComment(prefix: string): void {
    this.lineComment = prefix;
  }

  /** 开关 minimap 缩略图（v0.5.0）。 */
  setMinimapEnabled(enabled: boolean): void {
    this.minimapEnabled = enabled;
    this.clampScroll();
    this.scheduleRender();
  }

  /**
   * 注入可折叠区域（全量替换语义）。传空数组=清除所有折叠标记。
   * 若不调用此方法，setDocument 后会自动按缩进计算。
   */
  setFoldRegions(regions: FoldRegion[]): void {
    this.foldRegions = regions;
    // 清除已失效的折叠状态
    const valid = new Set(regions.map((r) => r.startLine));
    for (const start of this.foldedStarts) {
      if (!valid.has(start)) this.foldedStarts.delete(start);
    }
    this.scheduleRender();
  }

  /**
   * 自动按缩进计算折叠区域（集成方在打开文件 / 大幅编辑后调用）。
   */
  recomputeFoldRegions(): void {
    this.foldRegions = computeFoldRegions(
      (line) => this.doc.getLine(line),
      this.doc.lineCount,
      this.tabSize,
    );
    this.scheduleRender();
  }

  /** 切换指定行的折叠状态（行号槽折叠标记点击入口）。 */
  toggleFold(startLine: number): void {
    const region = this.foldRegions.find((r) => r.startLine === startLine);
    if (region === undefined) return;
    if (this.foldedStarts.has(startLine)) {
      this.foldedStarts.delete(startLine);
    } else {
      this.foldedStarts.add(startLine);
    }
    this.clampSelections();
    this.clampScroll();
    this.scheduleRender();
  }

  /** 判断某行是否在折叠区域内（被隐藏）。 */
  isLineHidden(line: number): boolean {
    for (const start of this.foldedStarts) {
      const region = this.foldRegions.find((r) => r.startLine === start);
      if (region === undefined) continue;
      if (line > region.startLine && line <= region.endLine) return true;
    }
    return false;
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
    // 行号槽右键时阻止浏览器默认上下文菜单（v0.4.0：编辑断点入口）
    this.canvas.addEventListener("contextmenu", (ev) => {
      if (this.onGutterContextMenu !== null && this.gutterLineFromEvent(ev) !== null) {
        ev.preventDefault();
      }
    });
    const move = (ev: MouseEvent): void => this.onMouseMove(ev);
    const up = (): void => {
      this.dragging = false;
      this.minimapDragging = false;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    this.removeWindowListeners.push(() => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    });
  }

  private onMouseDown(ev: MouseEvent): void {
    // 行号槽右键（v0.4.0：编辑断点 condition/hitCount/logMessage）：命中槽区即消费
    if (ev.button === 2 && this.onGutterContextMenu !== null) {
      const gutterHit = this.gutterLineFromEvent(ev);
      if (gutterHit !== null) {
        this.onGutterContextMenu(gutterHit);
        ev.preventDefault();
        return;
      }
    }
    if (ev.button !== 0) {
      return;
    }
    // Minimap 点击/拖拽（v0.5.0）：命中 minimap 区域 → 滚动到点击位置并开始拖拽
    if (this.isMinimapHit(ev)) {
      this.minimapDragging = true;
      this.scrollTop = this.minimapYToScroll(ev.clientY);
      this.clampScroll();
      this.scheduleRender();
      ev.preventDefault();
      return;
    }
    // 行号槽点击：先检查是否命中折叠标记（行号槽右侧区域）
    const gutterHit = this.gutterLineFromEvent(ev);
    if (gutterHit !== null) {
      // 折叠标记区域：行号槽右侧 12px
      const rect = this.canvas.getBoundingClientRect();
      const gutterX = ev.clientX - rect.left;
      if (gutterX >= this.gutterWidth - 14) {
        const region = this.foldRegions.find((r) => r.startLine === gutterHit);
        if (region !== undefined) {
          this.toggleFold(gutterHit);
          ev.preventDefault();
          return;
        }
      }
      // 行号槽点击（断点切换）
      if (this.onGutterClick !== null) {
        this.onGutterClick(gutterHit);
        ev.preventDefault();
        return;
      }
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
    if (this.minimapDragging) {
      this.scrollTop = this.minimapYToScroll(ev.clientY);
      this.clampScroll();
      this.scheduleRender();
      return;
    }
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
        case "/":
          this.toggleComment();
          ev.preventDefault();
          return;
        case "Backspace":
          this.deleteWordBackward();
          ev.preventDefault();
          return;
        case "Delete":
          this.deleteWordForward();
          ev.preventDefault();
          return;
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
        this.handleEnter();
        ev.preventDefault();
        break;
      case "Tab":
        if (ev.shiftKey) {
          this.handleShiftTab();
        } else {
          this.handleTab();
        }
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
        if (ev.altKey) {
          if (ev.shiftKey) {
            this.duplicateLine(-1);
          } else {
            this.moveLine(-1);
          }
        } else {
          this.moveCursorsVertical(-1, ev.shiftKey);
        }
        ev.preventDefault();
        break;
      case "ArrowDown":
        if (ev.altKey) {
          if (ev.shiftKey) {
            this.duplicateLine(1);
          } else {
            this.moveLine(1);
          }
        } else {
          this.moveCursorsVertical(1, ev.shiftKey);
        }
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
    // 自动配对：单字符开括号（IME 合成期间不走此路径，粘贴多字符不触发）
    if (text.length === 1) {
      const close = AUTO_PAIR_CLOSE[text];
      if (close !== undefined) {
        this.insertPair(text, close);
        return;
      }
    }
    this.replaceSelections(text);
  }

  /**
   * 自动配对插入：空选区 → open+close 光标居中；非空选区 → open+内容+close 包围。
   * 多选区降序应用保证偏移不失效；偏移计算委托 computeAutoPair 纯函数（可单测）。
   */
  private insertPair(open: string, close: string): void {
    const sels = this.selections.map((sel) => {
      const norm = normalizeSelection(sel);
      return {
        startOffset: this.doc.offsetAt(norm.start),
        endOffset: this.doc.offsetAt(norm.end),
      };
    });
    const results = computeAutoPair(sels, open, close, (s, e) => this.doc.getTextInRange(s, e));
    // 降序应用（高 startOffset 先），保证未应用选区的偏移不失效
    const order = sels.map((_, i) => i).sort((a, b) => (sels[b]?.startOffset ?? 0) - (sels[a]?.startOffset ?? 0));
    const newOffsets = new Array<number>(sels.length);
    for (const i of order) {
      const sel = sels[i];
      const result = results[i];
      if (sel === undefined || result === undefined) continue;
      this.doc.applyEdit({
        offset: sel.startOffset,
        length: sel.endOffset - sel.startOffset,
        text: result.text,
      });
      newOffsets[i] = result.cursorOffset;
    }
    this.selections = this.selections.map((_, index) => {
      const pos = this.doc.positionAt(newOffsets[index] ?? 0);
      return { anchor: pos, active: pos };
    });
    this.wakeCursor();
    this.ensureCursorVisible();
    this.scheduleRender();
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

  /**
   * Enter 键自动缩进：空选区继承当前行前导空白，行尾 { 触发加一级缩进；
   * 非空选区直接替换为 \n（内容被删除，不继承缩进）。多光标各自独立计算，
   * 降序应用 + 升序累计低位增量保证偏移不失效（与 replaceSelections 同策略）。
   */
  private handleEnter(): void {
    interface Sel {
      startOffset: number;
      endOffset: number;
      index: number;
      text: string;
    }
    const sels: Sel[] = this.selections.map((sel, index) => {
      const norm = normalizeSelection(sel);
      const startOffset = this.doc.offsetAt(norm.start);
      const endOffset = this.doc.offsetAt(norm.end);
      let text = "\n";
      if (startOffset === endOffset) {
        const lineText = this.lineText(norm.start.line);
        const indent = computeAutoIndent(lineText, norm.start.character, this.tabSize);
        text = "\n" + indent;
      }
      return { startOffset, endOffset, index, text };
    });
    const asc = [...sels].sort((a, b) => a.startOffset - b.startOffset);
    const shiftByIndex: number[] = new Array<number>(sels.length).fill(0);
    let shift = 0;
    for (const sel of asc) {
      shiftByIndex[sel.index] = shift;
      shift += sel.text.length - (sel.endOffset - sel.startOffset);
    }
    const desc = [...sels].sort((a, b) => b.startOffset - a.startOffset);
    const newOffsets: number[] = new Array<number>(sels.length);
    for (const sel of desc) {
      this.doc.applyEdit({ offset: sel.startOffset, length: sel.endOffset - sel.startOffset, text: sel.text });
      newOffsets[sel.index] = sel.startOffset + sel.text.length + (shiftByIndex[sel.index] ?? 0);
    }
    this.selections = this.selections.map((_, index) => {
      const pos = this.doc.positionAt(newOffsets[index] ?? 0);
      return { anchor: pos, active: pos };
    });
    this.wakeCursor();
    this.ensureCursorVisible();
    this.scheduleRender();
  }

  /**
   * Tab 键：单行选区 → 插入 tabSize 空格（走 replaceSelections，兼容多光标）；
   * 多行选区 → 整块行首加一级缩进。选区末尾恰在行首时不纳入该行（VS Code 惯例）。
   */
  private handleTab(): void {
    const norm = normalizeSelection(this.primarySelection());
    if (norm.start.line === norm.end.line) {
      this.replaceSelections(" ".repeat(this.tabSize));
      return;
    }
    const lastLine = norm.end.character === 0 && norm.end.line > norm.start.line
      ? norm.end.line - 1
      : norm.end.line;
    this.indentLines(norm.start.line, lastLine, false);
  }

  /**
   * Shift+Tab 反缩进：多行选区 → 整块行首删一级；单行空选区 → 当前行删一级并保持光标。
   */
  private handleShiftTab(): void {
    const primary = this.primarySelection();
    const norm = normalizeSelection(primary);
    if (norm.start.line === norm.end.line && isSelectionEmpty(primary)) {
      const lineText = this.lineText(norm.start.line);
      const { removed } = outdentLine(lineText, this.tabSize);
      if (removed > 0) {
        const lineStart = this.doc.offsetAt({ line: norm.start.line, character: 0 });
        this.doc.applyEdit({ offset: lineStart, length: removed, text: "" });
        const newChar = Math.max(0, norm.start.character - removed);
        this.selections = [{
          anchor: { line: norm.start.line, character: newChar },
          active: { line: norm.start.line, character: newChar },
        }];
        this.wakeCursor();
        this.ensureCursorVisible();
        this.scheduleRender();
      }
      return;
    }
    const lastLine = norm.end.character === 0 && norm.end.line > norm.start.line
      ? norm.end.line - 1
      : norm.end.line;
    this.indentLines(norm.start.line, lastLine, true);
  }

  /**
   * 批量行首缩进/反缩进：indent=true 加 tabSize 空格，false 删一级（调 outdentLine）。
   * 降序应用保证偏移不失效；完成后选区覆盖整块（与 VS Code 多行缩进后选区一致）。
   */
  private indentLines(firstLine: number, lastLine: number, outdent: boolean): void {
    const indent = " ".repeat(this.tabSize);
    const edits: Array<{ offset: number; length: number; text: string }> = [];
    for (let line = firstLine; line <= lastLine; line++) {
      const lineStart = this.doc.offsetAt({ line, character: 0 });
      if (outdent) {
        const lineText = this.lineText(line);
        const { removed } = outdentLine(lineText, this.tabSize);
        if (removed > 0) {
          edits.push({ offset: lineStart, length: removed, text: "" });
        }
      } else {
        edits.push({ offset: lineStart, length: 0, text: indent });
      }
    }
    edits.sort((a, b) => b.offset - a.offset);
    for (const edit of edits) {
      this.doc.applyEdit(edit);
    }
    this.selections = [{
      anchor: { line: firstLine, character: 0 },
      active: { line: lastLine, character: this.lineText(lastLine).length },
    }];
    this.wakeCursor();
    this.ensureCursorVisible();
    this.scheduleRender();
  }

  /**
   * Alt+Up/Down 行移动：将选区覆盖的行块与相邻行交换。
   * direction=-1 上移（与上行交换），+1 下移（与下行交换）。边界（首/末行）不动。
   * 选区末尾恰在行首时不纳入该行；选区整体平移 ±1 行保持方向与列。
   */
  private moveLine(direction: -1 | 1): void {
    const primary = this.primarySelection();
    const norm = normalizeSelection(primary);
    const firstLine = norm.start.line;
    const lastLine = norm.end.character === 0 && norm.end.line > norm.start.line
      ? norm.end.line - 1
      : norm.end.line;
    if (direction === -1 && firstLine === 0) return;
    if (direction === 1 && lastLine >= this.doc.lineCount - 1) return;

    if (direction === -1) {
      const startOffset = this.doc.offsetAt({ line: firstLine - 1, character: 0 });
      const endOffset = this.doc.offsetAt({ line: lastLine, character: this.lineText(lastLine).length });
      const text = this.doc.getTextInRange(startOffset, endOffset);
      const lines = text.split("\n");
      const above = lines.shift();
      if (above !== undefined) lines.push(above);
      this.doc.applyEdit({ offset: startOffset, length: endOffset - startOffset, text: lines.join("\n") });
    } else {
      const startOffset = this.doc.offsetAt({ line: firstLine, character: 0 });
      const endOffset = this.doc.offsetAt({ line: lastLine + 1, character: this.lineText(lastLine + 1).length });
      const text = this.doc.getTextInRange(startOffset, endOffset);
      const lines = text.split("\n");
      const below = lines.pop();
      if (below !== undefined) lines.unshift(below);
      this.doc.applyEdit({ offset: startOffset, length: endOffset - startOffset, text: lines.join("\n") });
    }
    const delta = direction;
    this.selections = [{
      anchor: { line: primary.anchor.line + delta, character: primary.anchor.character },
      active: { line: primary.active.line + delta, character: primary.active.character },
    }];
    this.wakeCursor();
    this.ensureCursorVisible();
    this.scheduleRender();
  }

  /**
   * Shift+Alt+Up/Down 行复制：将选区覆盖的行块复制到上/下方。
   * direction=-1 复制到上方（光标不移动），+1 复制到下方（光标移到复制块）。
   */
  private duplicateLine(direction: -1 | 1): void {
    const norm = normalizeSelection(this.primarySelection());
    const firstLine = norm.start.line;
    const lastLine = norm.end.character === 0 && norm.end.line > norm.start.line
      ? norm.end.line - 1
      : norm.end.line;
    // 获取选区覆盖行的文本
    const lines: string[] = [];
    for (let line = firstLine; line <= lastLine; line++) {
      lines.push(this.lineText(line));
    }
    const insertText = lines.join("\n") + "\n";
    if (direction === -1) {
      // 复制到上方：在 firstLine 行首插入
      const insertOffset = this.doc.offsetAt({ line: firstLine, character: 0 });
      this.doc.applyEdit({ offset: insertOffset, length: 0, text: insertText });
      // 光标不移动（仍在原行，但原行已下移 lastLine-firstLine+1 行）
      const shift = lastLine - firstLine + 1;
      this.selections = this.selections.map((sel) => ({
        anchor: { line: sel.anchor.line + shift, character: sel.anchor.character },
        active: { line: sel.active.line + shift, character: sel.active.character },
      }));
    } else {
      // 复制到下方：在 lastLine 行尾插入 \n + 行文本
      const insertOffset = this.doc.offsetAt({ line: lastLine, character: this.lineText(lastLine).length });
      this.doc.applyEdit({ offset: insertOffset, length: 0, text: "\n" + lines.join("\n") });
      // 光标移到复制块
      const shift = lastLine - firstLine + 1;
      this.selections = this.selections.map((sel) => ({
        anchor: { line: sel.anchor.line + shift, character: sel.anchor.character },
        active: { line: sel.active.line + shift, character: sel.active.character },
      }));
    }
    this.wakeCursor();
    this.ensureCursorVisible();
    this.scheduleRender();
  }

  /**
   * Ctrl+/ 行注释切换：选区覆盖行全部已注释 → 取消注释；否则 → 全部加注释。
   * 注释前缀由 setLineComment 设置（默认 "//"）；加注释时前缀后加一个空格，
   * 取消时优先移除 "prefix " 其次 "prefix"。空白行跳过判断但参与加注释。
   */
  private toggleComment(): void {
    const norm = normalizeSelection(this.primarySelection());
    const firstLine = norm.start.line;
    const lastLine = norm.end.character === 0 && norm.end.line > norm.start.line
      ? norm.end.line - 1
      : norm.end.line;
    const prefix = this.lineComment;

    let allCommented = true;
    for (let line = firstLine; line <= lastLine; line++) {
      const text = this.lineText(line);
      if (text.trim().length === 0) continue;
      if (!text.startsWith(prefix)) {
        allCommented = false;
        break;
      }
    }

    const edits: Array<{ offset: number; length: number; text: string }> = [];
    for (let line = firstLine; line <= lastLine; line++) {
      const lineText = this.lineText(line);
      const lineStart = this.doc.offsetAt({ line, character: 0 });
      if (allCommented) {
        if (lineText.startsWith(prefix + " ")) {
          edits.push({ offset: lineStart, length: prefix.length + 1, text: "" });
        } else if (lineText.startsWith(prefix)) {
          edits.push({ offset: lineStart, length: prefix.length, text: "" });
        }
      } else {
        edits.push({ offset: lineStart, length: 0, text: prefix + " " });
      }
    }
    edits.sort((a, b) => b.offset - a.offset);
    for (const edit of edits) {
      this.doc.applyEdit(edit);
    }
    this.selections = [{
      anchor: { line: firstLine, character: 0 },
      active: { line: lastLine, character: this.lineText(lastLine).length },
    }];
    this.wakeCursor();
    this.ensureCursorVisible();
    this.scheduleRender();
  }

  /**
   * Ctrl+Backspace 向前删词：非空选区先删选区；空选区删光标前一个词。
   * 词边界=连续字母数字/下划线 vs 连续非字母数字 vs 连续空白，三类互不交叉。
   */
  private deleteWordBackward(): void {
    if (this.selections.some((sel) => !isSelectionEmpty(sel))) {
      this.replaceSelections("");
      return;
    }
    const offsets = this.selections.map((sel) => this.doc.offsetAt(sel.active));
    const desc = offsets.map((offset, index) => ({ offset, index })).sort((a, b) => b.offset - a.offset);
    const newOffsets: number[] = new Array<number>(offsets.length);
    for (const { offset, index } of desc) {
      if (offset === 0) {
        newOffsets[index] = 0;
        continue;
      }
      const fullText = this.doc.getText();
      const end = offset;
      let start = offset;
      // 跳过前导空白
      while (start > 0 && /\s/.test(fullText[start - 1] ?? "")) start--;
      // 删除同类字符块
      if (start > 0) {
        const ch = fullText[start - 1] ?? "";
        const isWord = /[\w]/.test(ch);
        while (start > 0) {
          const prev = fullText[start - 1] ?? "";
          if (/[\w]/.test(prev) !== isWord) break;
          if (/\s/.test(prev)) break;
          start--;
        }
      }
      this.doc.applyEdit({ offset: start, length: end - start, text: "" });
      const below = offsets.filter((o) => o > 0 && o < offset).length;
      newOffsets[index] = start - below;
    }
    this.selections = this.selections.map((_, index) => {
      const pos = this.doc.positionAt(newOffsets[index] ?? 0);
      return { anchor: pos, active: pos };
    });
    this.wakeCursor();
    this.ensureCursorVisible();
    this.scheduleRender();
  }

  /**
   * Ctrl+Delete 向后删词：非空选区先删选区；空选区删光标后一个词。
   */
  private deleteWordForward(): void {
    if (this.selections.some((sel) => !isSelectionEmpty(sel))) {
      this.replaceSelections("");
      return;
    }
    const total = this.doc.length;
    const offsets = this.selections.map((sel) => this.doc.offsetAt(sel.active));
    const desc = offsets.map((offset, index) => ({ offset, index })).sort((a, b) => b.offset - a.offset);
    const newOffsets: number[] = new Array<number>(offsets.length);
    for (const { offset, index } of desc) {
      if (offset >= total) {
        newOffsets[index] = offset;
        continue;
      }
      const fullText = this.doc.getText();
      const start = offset;
      let end = offset;
      // 跳过前导空白
      while (end < total && /\s/.test(fullText[end] ?? "")) end++;
      // 删除同类字符块
      if (end < total) {
        const ch = fullText[end] ?? "";
        const isWord = /[\w]/.test(ch);
        while (end < total) {
          const next = fullText[end] ?? "";
          if (/[\w]/.test(next) !== isWord) break;
          if (/\s/.test(next)) break;
          end++;
        }
      }
      this.doc.applyEdit({ offset: start, length: end - start, text: "" });
      const below = offsets.filter((o) => o > 0 && o < offset).length;
      newOffsets[index] = start - below;
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
      let targetLine = sel.active.line + lineDelta;
      // 跳过折叠隐藏行
      while (targetLine >= 0 && targetLine < this.doc.lineCount && this.isLineHidden(targetLine)) {
        targetLine += lineDelta > 0 ? 1 : -1;
      }
      targetLine = Math.max(0, Math.min(this.doc.lineCount - 1, targetLine));
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
    // 光标落入折叠隐藏行 → 自动展开该折叠区域
    for (const sel of this.selections) {
      for (const pos of [sel.anchor, sel.active]) {
        for (const start of this.foldedStarts) {
          const region = this.foldRegions.find((r) => r.startLine === start);
          if (region === undefined) continue;
          if (pos.line > region.startLine && pos.line <= region.endLine) {
            this.foldedStarts.delete(start);
          }
        }
      }
    }
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
    const line = this.docLineFromScreenY(y);
    const character = columnForX(this.lineText(line), x, this.measurer);
    return { line, character };
  }

  /** 命中行号槽 → 0-based 行号；未命中返回 null（槽区 = 客户区 x 落在 gutterWidth 内）。 */
  private gutterLineFromEvent(ev: MouseEvent): number | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    if (x < 0 || x >= this.gutterWidth) return null;
    const y = ev.clientY - rect.top + this.scrollTop - this.padding;
    const line = this.docLineFromScreenY(y);
    if (line < 0 || line >= this.doc.lineCount) return null;
    return line;
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

  /** 内容区右边界 x（= 总宽 - minimap 宽；minimap 关闭时 = 总宽）。 */
  private contentRight(): number {
    return this.viewportWidth() - (this.minimapEnabled ? this.minimapWidth : 0);
  }

  private clampScroll(): void {
    // 可见行数（折叠后实际渲染行数）
    let visibleCount = 0;
    for (let line = 0; line < this.doc.lineCount; line++) {
      if (!this.isLineHidden(line)) visibleCount++;
    }
    this.scrollTop = clampScrollTop(this.scrollTop, visibleCount, this.lineHeight, this.viewportHeight());
    const maxLeft = Math.max(0, this.gutterWidth + this.maxLineWidth + 40 - this.contentRight());
    this.scrollLeft = Math.max(0, Math.min(this.scrollLeft, maxLeft));
  }

  private ensureCursorVisible(): void {
    const active = this.primarySelection().active;
    // 计算光标行的 screenIdx（跳过折叠行）
    let screenIdx = 0;
    for (let line = 0; line < active.line; line++) {
      if (!this.isLineHidden(line)) screenIdx++;
    }
    const y = this.padding + screenIdx * this.lineHeight;
    const viewH = this.viewportHeight();
    if (y < this.scrollTop) {
      this.scrollTop = y;
    } else if (y + this.lineHeight > this.scrollTop + viewH) {
      this.scrollTop = y + this.lineHeight - viewH;
    }
    const x = xForColumn(this.lineText(active.line), active.character, this.measurer);
    const viewW = this.contentRight() - this.gutterWidth;
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

    // 行号槽宽：按行数位数自适应 + 14px 断点圆点区（左缘）
    const digits = Math.max(2, String(this.doc.lineCount).length);
    this.gutterWidth = Math.ceil(digits * this.charWidth + 16 + 14);

    // 背景
    ctx.fillStyle = this.theme.background;
    ctx.fillRect(0, 0, viewW, viewH);

    const primaryLine = this.primarySelection().active.line;

    // 构建可视行映射（跳过折叠隐藏行）：visibleLines[i] = docLine
    const visibleLines: number[] = [];
    this.visibleLineMap.clear();
    for (let line = 0; line < this.doc.lineCount; line++) {
      if (this.isLineHidden(line)) {
        continue;
      }
      this.visibleLineMap.set(line, visibleLines.length);
      visibleLines.push(line);
    }
    this.renderVisibleLines = visibleLines;
    const totalScreenLines = visibleLines.length;
    const screenRange = visibleLineRange(this.scrollTop, viewH, this.lineHeight, totalScreenLines);

    // docLine → screenY 的辅助映射
    const yForDocLine = (docLine: number): number | null => {
      const screenIdx = this.visibleLineMap.get(docLine);
      if (screenIdx === undefined) return null;
      return this.padding + screenIdx * this.lineHeight - this.scrollTop;
    };

    // 当前行高亮
    const primaryY = yForDocLine(primaryLine);
    if (primaryY !== null) {
      ctx.fillStyle = this.theme.currentLineBackground;
      ctx.fillRect(this.gutterWidth, primaryY, this.contentRight() - this.gutterWidth, this.lineHeight);
    }

    // 调试停止行高亮（整行底色；箭头在行号槽段绘制）
    if (this.debugLine !== null) {
      const debugY = yForDocLine(this.debugLine);
      if (debugY !== null) {
        ctx.fillStyle = this.theme.debugLineBackground;
        ctx.fillRect(this.gutterWidth, debugY, this.contentRight() - this.gutterWidth, this.lineHeight);
      }
    }

    // 缩进指南线（文本之下、选区之下，避免遮盖字符）— 只画可见行
    for (let si = screenRange.first; si <= screenRange.last; si++) {
      const docLine = visibleLines[si] ?? -1;
      if (docLine < 0) continue;
      const y = this.padding + si * this.lineHeight - this.scrollTop;
      this.renderIndentGuidesForLine(docLine, y);
    }

    // 可视行：选区 → 文本
    this.maxLineWidth = 0;
    const contentClipRight = this.contentRight();
    for (let si = screenRange.first; si <= screenRange.last; si++) {
      const docLine = visibleLines[si] ?? -1;
      if (docLine < 0) continue;
      const y = this.padding + si * this.lineHeight - this.scrollTop;
      this.renderSelectionOnLine(docLine, y, contentClipRight);
    }
    for (let si = screenRange.first; si <= screenRange.last; si++) {
      const docLine = visibleLines[si] ?? -1;
      if (docLine < 0) continue;
      const y = this.padding + si * this.lineHeight - this.scrollTop;
      this.renderLineText(docLine, y);
      // 折叠指示线（如果该行是折叠区域的起始行）
      if (this.foldedStarts.has(docLine)) {
        this.renderFoldIndicator(docLine, y);
      }
    }

    // 诊断波浪线（文本之上、光标之下；只画可视行相交段）
    for (let si = screenRange.first; si <= screenRange.last; si++) {
      const docLine = visibleLines[si] ?? -1;
      if (docLine < 0) continue;
      const y = this.padding + si * this.lineHeight - this.scrollTop;
      this.renderDiagnosticsForLine(docLine, y);
    }

    // IME 合成串（画在主光标处，带下划线）
    if (this.compositionText.length > 0) {
      this.renderComposition();
    }

    // 光标
    if (this.cursorVisible) {
      this.renderCursors();
    }

    // 括号对匹配高亮（光标之上，框选配对的两个括号）
    this.renderBracketMatch();

    // 行号槽
    ctx.fillStyle = this.theme.gutterBackground;
    ctx.fillRect(0, 0, this.gutterWidth, viewH);
    // 断点标记（左缘 14px 区，垂直居中；按类型绘制不同形状）
    if (this.breakpointEntries.size > 0) {
      for (let si = screenRange.first; si <= screenRange.last; si++) {
        const docLine = visibleLines[si] ?? -1;
        if (docLine < 0) continue;
        const kind = this.breakpointEntries.get(docLine);
        if (kind === undefined) continue;
        const cy = this.padding + si * this.lineHeight - this.scrollTop + this.lineHeight / 2;
        drawBreakpointMark(ctx, 7, cy, kind, this.theme);
      }
    }
    // 调试停止行箭头（行号槽 ▶，与整行底色配套）
    if (this.debugLine !== null) {
      const debugY = yForDocLine(this.debugLine);
      if (debugY !== null) {
        const cy = debugY + this.lineHeight / 2;
        ctx.fillStyle = this.theme.diagnosticWarning;
        ctx.beginPath();
        ctx.moveTo(3, cy - 5);
        ctx.lineTo(11, cy);
        ctx.lineTo(3, cy + 5);
        ctx.closePath();
        ctx.fill();
      }
    }
    // 折叠标记（行号槽右侧 ▾/▸）
    this.renderFoldGutterMarks(visibleLines, screenRange);
    ctx.fillStyle = this.theme.lineNumberForeground;
    ctx.textAlign = "right";
    for (let si = screenRange.first; si <= screenRange.last; si++) {
      const docLine = visibleLines[si] ?? -1;
      if (docLine < 0) continue;
      const y = this.padding + si * this.lineHeight - this.scrollTop;
      ctx.fillText(String(docLine + 1), this.gutterWidth - 8, y + this.lineHeight / 2);
    }
    ctx.textAlign = "left";

    // Minimap 缩略图（v0.5.0：右侧渲染 + 视口指示框）
    this.renderMinimap(visibleLines, totalScreenLines);

    ctx.restore();

    // IME 候选窗定位到主光标
    const active = this.primarySelection().active;
    const cursorX = this.gutterWidth + xForColumn(this.lineText(active.line), active.character, this.measurer) - this.scrollLeft;
    const activeY = yForDocLine(active.line);
    const cursorY = activeY !== null ? activeY : this.padding;
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

  /** docLine → screenY（渲染期间有效；折叠隐藏行返回 null）。 */
  private screenYForDocLine(docLine: number): number | null {
    const screenIdx = this.visibleLineMap.get(docLine);
    if (screenIdx === undefined) return null;
    return this.padding + screenIdx * this.lineHeight - this.scrollTop;
  }

  private renderIndentGuidesForLine(docLine: number, y: number): void {
    const ctx = this.ctx;
    const text = this.lineText(docLine);
    const level = indentLevelOf(text, this.tabSize);
    if (level <= 0) return;
    ctx.strokeStyle = this.theme.indentGuide;
    ctx.lineWidth = 1;
    for (let lvl = 1; lvl <= level; lvl++) {
      const x = this.gutterWidth + lvl * this.tabSize * this.charWidth - this.scrollLeft;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, y);
      ctx.lineTo(Math.round(x) + 0.5, y + this.lineHeight);
      ctx.stroke();
    }
  }

  private renderBracketMatch(): void {
    const active = this.primarySelection().active;
    const result = findMatchingBracket(
      (line) => this.lineText(line),
      this.doc.lineCount,
      active,
    );
    if (result === null) return;
    const ctx = this.ctx;
    ctx.strokeStyle = this.theme.bracketMatchBorder;
    ctx.lineWidth = 1;
    const drawAt = (line: number, character: number): void => {
      const y = this.screenYForDocLine(line);
      if (y === null) return;
      const text = this.lineText(line);
      const x = this.gutterWidth + xForColumn(text, character, this.measurer) - this.scrollLeft;
      const w = Math.max(2, this.charWidth);
      ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, w, this.lineHeight - 1);
    };
    drawAt(result.trigger.line, result.trigger.character);
    drawAt(result.match.line, result.match.character);
  }

  private renderComposition(): void {
    const ctx = this.ctx;
    const active = this.primarySelection().active;
    const lineText = this.lineText(active.line);
    const x = this.gutterWidth + xForColumn(lineText, active.character, this.measurer) - this.scrollLeft;
    const y = this.screenYForDocLine(active.line);
    if (y === null) return;
    const width = this.compositionText.length * this.charWidth;
    ctx.fillStyle = this.theme.compositionForeground;
    ctx.fillText(this.compositionText, x, y + this.lineHeight / 2);
    ctx.fillStyle = this.theme.compositionUnderline;
    ctx.fillRect(x, y + this.lineHeight - 2, width, 1);
  }

  /** 诊断波浪线：单行求交段（error 红 / warning 黄 / info·hint 灰）。 */
  private renderDiagnosticsForLine(docLine: number, y: number): void {
    if (this.diagnostics.length === 0) return;
    for (const diag of this.diagnostics) {
      if (docLine < diag.line || docLine > diag.endLine) continue;
      const color =
        diag.severity === "error"
          ? this.theme.diagnosticError
          : diag.severity === "warning"
            ? this.theme.diagnosticWarning
            : this.theme.lineNumberForeground;
      const lineText = this.lineText(docLine);
      const startChar = docLine === diag.line ? Math.min(diag.character, lineText.length) : 0;
      const endChar = docLine === diag.endLine ? Math.min(diag.endCharacter, lineText.length) : lineText.length;
      const x1 = this.gutterWidth + xForColumn(lineText, startChar, this.measurer) - this.scrollLeft;
      const width = Math.max(xForColumn(lineText, endChar, this.measurer) - xForColumn(lineText, startChar, this.measurer), this.charWidth);
      const baseY = y + this.lineHeight - 3;
      this.strokeSquiggle(x1, baseY, width, color);
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
      const y = this.screenYForDocLine(active.line);
      if (y === null) continue;
      if (y + this.lineHeight < 0 || y > this.viewportHeight()) {
        continue;
      }
      ctx.fillRect(Math.round(x), y, 2, this.lineHeight);
    }
  }

  /** 折叠指示线：在折叠区域起始行末尾画一条水平线 + 折叠计数文本。 */
  private renderFoldIndicator(docLine: number, y: number): void {
    const region = this.foldRegions.find((r) => r.startLine === docLine);
    if (region === undefined) return;
    const ctx = this.ctx;
    const hidden = region.endLine - region.startLine;
    const lineText = this.lineText(docLine);
    const textWidth = lineText.length * this.charWidth;
    const x1 = this.gutterWidth - this.scrollLeft + textWidth + 4;
    const x2 = x1 + Math.max(20, this.charWidth * 4);
    const midY = y + this.lineHeight / 2;
    // 折叠线
    ctx.strokeStyle = this.theme.lineNumberForeground;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x1, midY);
    ctx.lineTo(x2, midY);
    ctx.stroke();
    // 折叠计数
    ctx.fillStyle = this.theme.lineNumberForeground;
    ctx.font = `${Math.round(this.fontSize * 0.85)}px ${this.fontFamily}`;
    ctx.fillText(`⋯${hidden}`, x2 + 2, midY);
    ctx.font = `${this.fontSize}px ${this.fontFamily}`;
  }

  /** 行号槽折叠标记：▼（已折叠）/ ▸（可折叠）。 */
  private renderFoldGutterMarks(visibleLines: number[], screenRange: { first: number; last: number }): void {
    const ctx = this.ctx;
    const foldMarkX = this.gutterWidth - 2;
    for (let si = screenRange.first; si <= screenRange.last; si++) {
      const docLine = visibleLines[si] ?? -1;
      if (docLine < 0) continue;
      const region = this.foldRegions.find((r) => r.startLine === docLine);
      if (region === undefined) continue;
      const y = this.padding + si * this.lineHeight - this.scrollTop + this.lineHeight / 2;
      ctx.fillStyle = this.theme.lineNumberForeground;
      ctx.font = `${Math.round(this.fontSize * 0.75)}px ${this.fontFamily}`;
      ctx.textAlign = "right";
      const mark = this.foldedStarts.has(docLine) ? "▸" : "▾";
      ctx.fillText(mark, foldMarkX, y);
      ctx.font = `${this.fontSize}px ${this.fontFamily}`;
      ctx.textAlign = "left";
    }
  }

  /**
   * Minimap 缩略图渲染（v0.5.0）：右侧渲染文档缩略行 + 视口指示框。
   * 布局计算委托 minimapLayout 纯函数；行内容按非空白字符 run 渲染小矩形，
   * 虚拟化（只画 minimap 可视行），折叠隐藏行同步跳过。
   */
  private renderMinimap(visibleLines: number[], visibleCount: number): void {
    if (!this.minimapEnabled || visibleCount <= 0) return;
    const ctx = this.ctx;
    const viewH = this.viewportHeight();
    const minimapX = this.contentRight();
    const minimapW = this.minimapWidth;

    // 背景
    ctx.fillStyle = this.theme.minimapBackground;
    ctx.fillRect(minimapX, 0, minimapW, viewH);

    const layout = minimapLayout(
      this.scrollTop,
      viewH,
      this.lineHeight,
      visibleCount,
      this.minimapLineHeight,
      viewH,
    );
    if (layout.lastLine < layout.firstLine) return;

    // 渲染缩略行内容：非空白字符 run → 小矩形
    ctx.fillStyle = this.theme.minimapForeground;
    const minimapCharWidth = 1.2;
    const maxChars = Math.floor((minimapW - 4) / minimapCharWidth);
    for (let i = layout.firstLine; i <= layout.lastLine; i++) {
      const docLine = visibleLines[i] ?? -1;
      if (docLine < 0) continue;
      const text = this.lineText(docLine);
      if (text.trim().length === 0) continue;
      const y = layout.offsetY + i * this.minimapLineHeight - layout.minimapScrollTop;
      if (y + this.minimapLineHeight < 0 || y > viewH) continue;
      // 按非空白 run 渲染（减少 fillRect 调用数）
      let runStart = -1;
      const limit = Math.min(text.length, maxChars);
      for (let c = 0; c < limit; c++) {
        const ch = text[c];
        if (ch !== " " && ch !== "\t") {
          if (runStart < 0) runStart = c;
        } else if (runStart >= 0) {
          ctx.fillRect(minimapX + 2 + runStart * minimapCharWidth, y, (c - runStart) * minimapCharWidth, this.minimapLineHeight - 0.5);
          runStart = -1;
        }
      }
      if (runStart >= 0) {
        ctx.fillRect(minimapX + 2 + runStart * minimapCharWidth, y, (limit - runStart) * minimapCharWidth, this.minimapLineHeight - 0.5);
      }
    }

    // 视口指示框
    ctx.fillStyle = this.theme.minimapViewport;
    const vpTop = Math.max(0, layout.viewportTop);
    const vpHeight = Math.min(viewH - vpTop, layout.viewportHeight);
    if (vpHeight > 0) {
      ctx.fillRect(minimapX, vpTop, minimapW, vpHeight);
    }
  }

  /** 判断鼠标事件是否命中 minimap 区域。 */
  private isMinimapHit(ev: MouseEvent): boolean {
    if (!this.minimapEnabled) return false;
    const rect = this.canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    return x >= this.contentRight();
  }

  /**
   * minimap 点击 Y → 编辑器 scrollTop（使点击位置对应的行居中）。
   * 使用 renderVisibleLines（渲染期间填充）做 screenIdx → docLine 映射。
   */
  private minimapYToScroll(clientY: number): number {
    const rect = this.canvas.getBoundingClientRect();
    const y = clientY - rect.top;
    const visibleCount = this.renderVisibleLines.length;
    if (visibleCount === 0) return 0;
    const layout = minimapLayout(
      this.scrollTop,
      this.viewportHeight(),
      this.lineHeight,
      visibleCount,
      this.minimapLineHeight,
      this.viewportHeight(),
    );
    const minimapContentY = y - layout.offsetY + layout.minimapScrollTop;
    const screenLineIdx = Math.max(0, Math.min(visibleCount - 1, Math.floor(minimapContentY / this.minimapLineHeight)));
    return Math.max(0, screenLineIdx * this.lineHeight - this.viewportHeight() / 2);
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

/**
 * 在行号槽 (cx, cy) 绘制断点标记（v0.4.0）。
 * - normal：红实心圆（半径 4.5）。
 * - conditional：黄外环（半径 4.5 描边）+ 红中心实心点（半径 1.8）——视觉提示"附加条件"。
 * - log：青菱形（边长 9）——与暂停断点的圆做形状区分，提示"不暂停"。
 */
function drawBreakpointMark(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  kind: BreakpointKind,
  theme: Theme
): void {
  if (kind === "log") {
    ctx.fillStyle = theme.breakpointLog;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 5);
    ctx.lineTo(cx + 5, cy);
    ctx.lineTo(cx, cy + 5);
    ctx.lineTo(cx - 5, cy);
    ctx.closePath();
    ctx.fill();
    return;
  }
  if (kind === "conditional") {
    // 外环
    ctx.strokeStyle = theme.breakpointConditional;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
    ctx.stroke();
    // 中心点
    ctx.fillStyle = theme.breakpoint;
    ctx.beginPath();
    ctx.arc(cx, cy, 1.8, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.fillStyle = theme.breakpoint;
  ctx.beginPath();
  ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
  ctx.fill();
}
