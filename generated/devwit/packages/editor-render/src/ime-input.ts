/** IME/键盘输入捕获的回调集。 */
export interface ImeInputCallbacks {
  /** 非合成文本提交（普通键入、粘贴）。 */
  onCommitText(text: string): void;
  onCompositionStart(): void;
  /** 合成串更新（编辑器据此在光标处画出带下划线的临时串）。 */
  onCompositionUpdate(text: string): void;
  /** 合成结束，提交最终串。 */
  onCompositionEnd(text: string): void;
  /** 所有按键先经此回调（编辑命令：方向键/退格/快捷键等）。 */
  onKeyDown(ev: KeyboardEvent): void;
  onFocus?(): void;
  onBlur?(): void;
}

/**
 * 隐藏 textarea 输入法捕获层：聚焦它来获得键盘事件与 IME composition 事件流。
 * compositionend 中清空 value，避免随后紧跟的 input 事件重复提交同一合成串。
 */
export class ImeInput {
  readonly element: HTMLTextAreaElement;
  private readonly callbacks: ImeInputCallbacks;
  private composing = false;
  private readonly removeListeners: Array<() => void> = [];

  constructor(callbacks: ImeInputCallbacks, host?: HTMLElement) {
    this.callbacks = callbacks;
    const el = document.createElement("textarea");
    el.setAttribute("autocapitalize", "off");
    el.setAttribute("autocomplete", "off");
    el.setAttribute("autocorrect", "off");
    el.setAttribute("spellcheck", "false");
    el.setAttribute("aria-label", "editor input");
    // 视觉隐藏但保持可聚焦、可参与 IME 候选窗定位
    el.style.position = "absolute";
    el.style.padding = "0";
    el.style.border = "none";
    el.style.outline = "none";
    el.style.resize = "none";
    el.style.overflow = "hidden";
    el.style.width = "1px";
    el.style.height = "1em";
    el.style.opacity = "0";
    el.style.zIndex = "-1";
    el.style.whiteSpace = "pre";
    this.element = el;

    this.listen("compositionstart", () => {
      this.composing = true;
      callbacks.onCompositionStart();
    });
    this.listen("compositionupdate", (ev) => {
      callbacks.onCompositionUpdate((ev as CompositionEvent).data);
    });
    this.listen("compositionend", (ev) => {
      this.composing = false;
      const data = (ev as CompositionEvent).data;
      el.value = "";
      callbacks.onCompositionEnd(data);
    });
    this.listen("input", () => {
      if (this.composing) {
        return;
      }
      const value = el.value;
      if (value.length > 0) {
        el.value = "";
        callbacks.onCommitText(value);
      }
    });
    this.listen("keydown", (ev) => {
      callbacks.onKeyDown(ev as KeyboardEvent);
    });
    this.listen("focus", () => callbacks.onFocus?.());
    this.listen("blur", () => callbacks.onBlur?.());

    (host ?? document.body).appendChild(el);
  }

  get isComposing(): boolean {
    return this.composing;
  }

  focus(): void {
    this.element.focus({ preventScroll: true });
  }

  /** 把隐藏 textarea 移到光标像素位置，让 IME 候选窗跟随光标。 */
  setPosition(x: number, y: number): void {
    this.element.style.left = `${Math.round(x)}px`;
    this.element.style.top = `${Math.round(y)}px`;
  }

  dispose(): void {
    for (const off of this.removeListeners) {
      off();
    }
    this.removeListeners.length = 0;
    this.element.remove();
  }

  private listen(type: string, handler: (ev: Event) => void): void {
    this.element.addEventListener(type, handler);
    this.removeListeners.push(() => this.element.removeEventListener(type, handler));
  }
}
