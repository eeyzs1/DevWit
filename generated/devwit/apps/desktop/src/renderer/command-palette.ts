/**
 * 命令面板（v0.7.30）：Ctrl+Shift+P 命令 / Ctrl+P 文件——顶部居中浮层，
 * 模糊过滤（palette-filter 纯函数）+ 键盘导航（↑↓/Enter/Escape）。
 *
 * 单例：全局一份实例，open(mode) 复用；Escape 关闭（a11y 同 v0.7.29 口径）。
 */
import { t } from "@devwit/i18n";
import { el } from "./dom.js";
import { filterPalette, type PaletteItem } from "./palette-filter.js";

export type PaletteMode = "commands" | "files";

export interface PaletteCommand {
  id: string;
  /** 过滤与显示名（经 t() 本地化）。 */
  label: string;
  /** 执行（关闭面板后调用）。 */
  run: () => void;
}

export interface CommandPaletteDeps {
  /** 文件模式的数据源（工作区相对路径，正斜杠）。 */
  listFiles(): string[];
  /** 文件选择动作。 */
  openFile(path: string): void;
  /** 命令目录（含 id/label/run）。 */
  listCommands(): PaletteCommand[];
}

export interface CommandPaletteHandle {
  open(mode: PaletteMode): void;
  close(): void;
  applyLocale(): void;
}

export function mountCommandPalette(deps: CommandPaletteDeps): CommandPaletteHandle {
  const mask = el("div", "dw-modal-mask dw-palette-mask");
  const box = el("div", "dw-palette");
  mask.appendChild(box);
  let opened = false;

  const input = el("input", "dw-input dw-palette-input") as HTMLInputElement;
  input.type = "text";
  input.spellcheck = false;
  const hint = el("div", "dw-palette-hint");
  const list = el("div", "dw-palette-list");
  box.append(input, hint, list);

  let mode: PaletteMode = "commands";
  let activeIndex = 0;
  let currentItems: PaletteItem<{ kind: "command"; run: () => void } | { kind: "file"; path: string }>[] = [];

  function close(): void {
    if (!opened) return;
    opened = false;
    mask.remove();
  }

  function refresh(): void {
    const query = input.value;
    if (mode === "commands") {
      const commands = deps.listCommands().map((cmd) => ({
        label: cmd.label,
        payload: { kind: "command" as const, run: cmd.run },
      }));
      currentItems = filterPalette(commands, query);
      hint.textContent = t("palette.commands.hint");
    } else {
      const files = deps.listFiles().map((path) => ({
        label: path,
        payload: { kind: "file" as const, path },
      }));
      currentItems = filterPalette(files, query);
      hint.textContent = t("palette.files.hint");
    }
    activeIndex = 0;
    renderList();
  }

  function renderList(): void {
    list.textContent = "";
    if (currentItems.length === 0) {
      list.appendChild(el("div", "dw-palette-empty", t("palette.empty")));
      return;
    }
    for (let i = 0; i < currentItems.length; i++) {
      const item = currentItems[i];
      if (item === undefined) continue;
      const row = el("div", `dw-palette-item${i === activeIndex ? " dw-palette-item-active" : ""}`);
      row.textContent = item.label;
      row.title = item.label;
      row.addEventListener("click", () => {
        execute(i);
      });
      row.addEventListener("mousemove", () => {
        if (activeIndex !== i) {
          activeIndex = i;
          renderList();
        }
      });
      list.appendChild(row);
    }
    list.querySelector(".dw-palette-item-active")?.scrollIntoView({ block: "nearest" });
  }

  function execute(index: number): void {
    const item = currentItems[index];
    if (item === undefined) return;
    close();
    if (item.payload.kind === "command") {
      item.payload.run();
    } else {
      deps.openFile(item.payload.path);
    }
  }

  input.addEventListener("input", refresh);
  mask.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      close();
    } else if (ev.key === "ArrowDown") {
      ev.preventDefault();
      if (currentItems.length > 0) {
        activeIndex = (activeIndex + 1) % currentItems.length;
        renderList();
      }
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      if (currentItems.length > 0) {
        activeIndex = (activeIndex - 1 + currentItems.length) % currentItems.length;
        renderList();
      }
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      execute(activeIndex);
    }
  });
  mask.addEventListener("click", (ev) => {
    if (ev.target === mask) close();
  });

  function applyLocale(): void {
    input.placeholder = mode === "commands" ? t("palette.commands.placeholder") : t("palette.files.placeholder");
    hint.textContent = mode === "commands" ? t("palette.commands.hint") : t("palette.files.hint");
  }

  return {
    open(nextMode: PaletteMode): void {
      if (opened) close();
      mode = nextMode;
      opened = true;
      input.value = "";
      applyLocale();
      refresh();
      document.body.appendChild(mask);
      input.focus();
    },
    close,
    applyLocale,
  };
}
