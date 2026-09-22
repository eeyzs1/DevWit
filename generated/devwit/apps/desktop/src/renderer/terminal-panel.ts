/**
 * 终端面板（v0.7.28）：侧栏「终端」页签——真实 shell（主进程 pty/pipe 后端）。
 *
 * 渲染模型（诚实取舍）：流式追加 + ANSI SGR 样式解析（parseAnsi 纯函数），
 * 不模拟屏幕缓冲——全屏 TUI 程序（vim/htop）不在支持面；命令输出/REPL 交互
 * 是一等场景。光标控制序列剥离。
 *
 * 键盘输入：面板可见且聚焦时捕获 keydown → 转义序列（方向键/Home/End/
 * Ctrl 组合）经 IPC 写入 shell；IME 输入经隐藏 textarea 的 input 事件。
 */
import type { DevwitApi, TerminalSessionInfo } from "@devwit/contracts";
import { t } from "@devwit/i18n";
import { parseAnsi } from "./terminal-ansi.js";
import { el } from "./dom.js";

export interface TerminalPanelDeps {
  api: DevwitApi;
  /** 工作区根（终端 cwd；空串时用用户主目录）。 */
  getWorkspaceRoot(): string;
}

export interface TerminalPanelHandle {
  /** 页签激活时调用（首次创建会话）。 */
  activate(): void;
  /** 语言热生效。 */
  applyLocale(): void;
  /** 卸载（退订 + 终止会话 + 移除 DOM）。 */
  dispose(): void;
}

/** 输出行缓冲上限（环形丢弃最旧——防长会话 DOM 无界）。 */
const MAX_LINES = 5000;
/** 键 → 转义序列映射（xterm 惯例）。 */
const KEY_ESCAPES: Record<string, string> = {
  ArrowUp: "\u001b[A",
  ArrowDown: "\u001b[B",
  ArrowRight: "\u001b[C",
  ArrowLeft: "\u001b[D",
  Home: "\u001b[H",
  End: "\u001b[F",
  Delete: "\u001b[3~",
  PageUp: "\u001b[5~",
  PageDown: "\u001b[6~",
  Insert: "\u001b[2~",
};

export function mountTerminalPanel(container: HTMLElement, deps: TerminalPanelDeps): TerminalPanelHandle {
  const { api } = deps;
  const root = el("div", "dw-terminal");
  root.style.display = "none";
  container.appendChild(root);

  const toolbar = el("div", "dw-terminal-toolbar");
  const restartBtn = el("button", "dw-btn dw-btn-small");
  const disposeBtn = el("button", "dw-btn dw-btn-small");
  toolbar.append(restartBtn, disposeBtn);
  root.appendChild(toolbar);

  /** 输出区：行级追加（每行内 ANSI 分段 span）。 */
  const output = el("div", "dw-terminal-output");
  root.appendChild(output);

  /** 隐藏输入捕获层（IME/粘贴经 textarea；普通键经 keydown）。 */
  const input = el("textarea", "dw-terminal-input") as HTMLTextAreaElement;
  input.setAttribute("aria-label", "terminal input");
  input.spellcheck = false;
  root.appendChild(input);

  let session: TerminalSessionInfo | null = null;
  let exited = false;
  /** 行缓冲：一段输出可能只有半个 ANSI 序列——留在缓冲等下一块补全。 */
  let pending = "";
  const lines: HTMLElement[] = [];

  const unsubOutput = api.terminal.onOutput((id, data) => {
    if (session === null || id !== session.id) return;
    appendOutput(data);
  });
  const unsubExit = api.terminal.onExit((id) => {
    if (session === null || id !== session.id) return;
    exited = true;
    appendRaw(t("terminal.exited", { code: "" }));
    input.disabled = true;
  });

  function appendRaw(text: string): void {
    for (const piece of text.split("\n")) {
      const line = el("div", "dw-terminal-line");
      line.textContent = piece;
      output.appendChild(line);
      lines.push(line);
    }
    trimLines();
    output.scrollTop = output.scrollHeight;
  }

  function appendOutput(data: string): void {
    pending += data;
    // 以最后一个换行切分：尾部无换行的部分留在缓冲（半行/半序列）
    const lastNewline = pending.lastIndexOf("\n");
    if (lastNewline < 0) return;
    const complete = pending.slice(0, lastNewline);
    pending = pending.slice(lastNewline + 1);
    for (const raw of complete.split("\n")) {
      const line = el("div", "dw-terminal-line");
      for (const segment of parseAnsi(raw)) {
        if (segment.classNames.length === 0) {
          line.appendChild(document.createTextNode(segment.text));
        } else {
          const span = el("span", `dw-t ${segment.classNames.join(" ")}`, segment.text);
          line.appendChild(span);
        }
      }
      output.appendChild(line);
      lines.push(line);
    }
    trimLines();
    output.scrollTop = output.scrollHeight;
  }

  function trimLines(): void {
    while (lines.length > MAX_LINES) {
      const line = lines.shift();
      line?.remove();
    }
  }

  async function startSession(): Promise<void> {
    if (session !== null && !exited) return;
    output.textContent = "";
    lines.length = 0;
    pending = "";
    exited = false;
    input.disabled = false;
    try {
      const cwd = deps.getWorkspaceRoot() !== "" ? deps.getWorkspaceRoot() : undefined as unknown as string;
      session = await api.terminal.create(cwd);
      appendRaw(t("terminal.started", { shell: session.shell }));
    } catch (error) {
      appendRaw(t("terminal.startFailed", { detail: error instanceof Error ? error.message : String(error) }));
      exited = true;
      input.disabled = true;
    }
    input.focus();
  }

  function killSession(): void {
    if (session !== null && !exited) {
      api.terminal.dispose(session.id);
    }
    session = null;
    exited = true;
  }

  restartBtn.addEventListener("click", () => {
    killSession();
    void startSession();
  });
  disposeBtn.addEventListener("click", () => {
    killSession();
    output.textContent = "";
    lines.length = 0;
  });

  function send(data: string): void {
    if (session === null || exited) return;
    api.terminal.input(session.id, data);
  }

  input.addEventListener("keydown", (ev) => {
    if (exited) return;
    const escape = KEY_ESCAPES[ev.key];
    if (escape !== undefined) {
      ev.preventDefault();
      send(escape);
      return;
    }
    if (ev.key === "Enter") {
      ev.preventDefault();
      send("\r");
      return;
    }
    if (ev.key === "Tab") {
      ev.preventDefault();
      send("\t");
      return;
    }
    if (ev.key === "Backspace") {
      ev.preventDefault();
      // 退格删除（DEL 码）；textarea 自身内容在 input 事件路径，此处无需消费
      input.value = "";
      send("\u007f");
      return;
    }
    if (ev.ctrlKey && ev.key.length === 1) {
      // Ctrl+字母 → 控制码（C=0x03 中断 / D=0x04 EOF / L=0x0c 清屏 等）
      const code = ev.key.toUpperCase().charCodeAt(0) - 64;
      if (code > 0 && code <= 31) {
        ev.preventDefault();
        send(String.fromCharCode(code));
      }
      return;
    }
  });
  // IME/粘贴：textarea 的 input 事件给 shell（输入法确认/中键粘贴）
  input.addEventListener("input", () => {
    if (input.value !== "") {
      send(input.value);
      input.value = "";
    }
  });

  output.addEventListener("click", () => input.focus());

  function applyLocale(): void {
    restartBtn.textContent = t("terminal.restart");
    restartBtn.title = t("terminal.restart.tooltip");
    disposeBtn.textContent = t("terminal.close");
    disposeBtn.title = t("terminal.close.tooltip");
  }

  return {
    activate(): void {
      root.style.display = "";
      void startSession();
      input.focus();
    },
    applyLocale,
    dispose(): void {
      unsubOutput();
      unsubExit();
      killSession();
      root.remove();
    },
  };
}
