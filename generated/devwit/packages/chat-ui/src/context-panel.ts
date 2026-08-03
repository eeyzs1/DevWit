import type { ContextItemType } from "@devwit/contracts";
import { onDidChangeLocale, t } from "@devwit/i18n";
import type { ContextPanelController } from "./context-panel-controller.js";

/**
 * context-panel DOM 视图（WU012 / AC2）：上下文组成面板。
 * - 逐项开关：全部 8 类上下文类型，实时生效（toggle → engine → 下次请求即按新策略）；
 * - manifest 展示：最近一次请求的每项内容、token 占用、计数方式（exact/estimated 标注）；
 * - 未开启项同样可见（content 为空、tokens=0）——可见性不依赖开启状态。
 */
export interface ContextPanelHandle {
  readonly root: HTMLElement;
  dispose(): void;
}

/** 上下文类型 → 词典键（与 renderer 的模式对话框共用同一组 ctx.* 文案）。 */
const TYPE_LABEL_KEY: Record<ContextItemType, `ctx.${ContextItemType}`> = {
  system_prompt: "ctx.system_prompt",
  tool_definitions: "ctx.tool_definitions",
  file_fragment: "ctx.file_fragment",
  git_status: "ctx.git_status",
  terminal_output: "ctx.terminal_output",
  selection: "ctx.selection",
  conversation_history: "ctx.conversation_history",
  codebase_match: "ctx.codebase_match",
  diagnostics: "ctx.diagnostics",
  workflow: "ctx.workflow",
  custom: "ctx.custom",
};

const TYPE_ORDER: readonly ContextItemType[] = [
  "system_prompt",
  "tool_definitions",
  "conversation_history",
  "selection",
  "file_fragment",
  "codebase_match",
  "git_status",
  "terminal_output",
  "diagnostics",
  "workflow",
  "custom",
];

export function mountContextPanel(container: HTMLElement, controller: ContextPanelController): ContextPanelHandle {
  const root = document.createElement("div");
  root.className = "dw-context";

  const header = document.createElement("div");
  header.className = "dw-context-header";
  const refreshBtn = document.createElement("button");
  refreshBtn.className = "dw-btn dw-btn-small";
  refreshBtn.addEventListener("click", () => void controller.refresh());
  const exportBtn = document.createElement("button");
  exportBtn.className = "dw-btn dw-btn-small";
  exportBtn.addEventListener("click", () => void controller.exportCurrent());
  root.appendChild(header);
  header.append(refreshBtn, exportBtn);

  const toggleList = document.createElement("div");
  toggleList.className = "dw-context-toggles";
  root.appendChild(toggleList);

  const manifestBox = document.createElement("div");
  manifestBox.className = "dw-context-manifest";
  root.appendChild(manifestBox);
  container.appendChild(root);

  /** 静态文案随语言热更新（AC12）。 */
  function applyLocale(): void {
    header.textContent = t("ctxpanel.title");
    refreshBtn.textContent = t("ctxpanel.refresh");
    exportBtn.textContent = t("ctxpanel.export");
  }

  function render(): void {
    const { policy, manifest } = controller.current;

    exportBtn.disabled = manifest === null;
    toggleList.textContent = "";
    for (const type of TYPE_ORDER) {
      const row = document.createElement("label");
      row.className = "dw-context-toggle";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = policy?.[type] ?? false;
      checkbox.addEventListener("change", () => void controller.setEnabled(type, checkbox.checked));
      const name = document.createElement("span");
      name.textContent = t(TYPE_LABEL_KEY[type]);
      row.append(checkbox, name);
      toggleList.appendChild(row);
    }

    manifestBox.textContent = "";
    if (manifest === null) {
      const empty = document.createElement("div");
      empty.className = "dw-context-empty";
      empty.textContent = t("ctxpanel.empty");
      manifestBox.appendChild(empty);
      return;
    }
    const meta = document.createElement("div");
    meta.className = "dw-context-meta";
    meta.textContent = `${manifest.model} · ${t("ctxpanel.total", { n: manifest.totalTokens })} · ${manifest.timestamp}`;
    manifestBox.appendChild(meta);
    for (const item of manifest.items) {
      const row = document.createElement("div");
      row.className = "dw-context-item";
      if (!item.enabled) {
        row.classList.add("dw-context-item-off");
      }
      const title = document.createElement("div");
      title.className = "dw-context-item-title";
      const countingMark = item.counting === "estimated" ? t("ctxpanel.estimated") : "";
      // AC19：带稳定 key 的项（codebase_match 命中块）渲染逐项开关，
      // 其余项维持类型级开关（面板顶部 toggles），此处仅状态点展示
      if (item.key !== undefined) {
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = item.enabled;
        checkbox.className = "dw-context-item-check";
        checkbox.addEventListener("change", () => void controller.setItemOverride(item.key!, checkbox.checked));
        title.appendChild(checkbox);
      }
      const titleText = document.createElement("span");
      titleText.textContent = `${item.key === undefined ? (item.enabled ? "●" : "○") + " " : ""}${item.label} — ${item.tokens} tokens${countingMark}`;
      title.appendChild(titleText);
      row.appendChild(title);
      if (item.enabled && item.content.length > 0) {
        const detail = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = t("ctxpanel.content");
        const pre = document.createElement("pre");
        pre.className = "dw-context-item-content";
        pre.textContent = item.content;
        detail.append(summary, pre);
        row.appendChild(detail);
      }
      manifestBox.appendChild(row);
    }
  }

  const unsubscribe = controller.onChange(render);
  const unsubscribeLocale = onDidChangeLocale(() => {
    applyLocale();
    render();
  });
  applyLocale();
  void controller.refresh();
  render();

  return {
    root,
    dispose(): void {
      unsubscribe();
      unsubscribeLocale();
      root.remove();
    },
  };
}
