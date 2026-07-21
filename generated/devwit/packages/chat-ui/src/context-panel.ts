import type { ContextItemType } from "@devwit/contracts";
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

const TYPE_LABELS: Record<ContextItemType, string> = {
  system_prompt: "系统提示",
  tool_definitions: "工具定义",
  file_fragment: "文件片段",
  git_status: "Git 状态",
  terminal_output: "终端输出",
  selection: "选区",
  conversation_history: "会话历史",
  custom: "自定义",
};

const TYPE_ORDER: readonly ContextItemType[] = [
  "system_prompt",
  "tool_definitions",
  "conversation_history",
  "selection",
  "file_fragment",
  "git_status",
  "terminal_output",
  "custom",
];

export function mountContextPanel(container: HTMLElement, controller: ContextPanelController): ContextPanelHandle {
  const root = document.createElement("div");
  root.className = "dw-context";

  const header = document.createElement("div");
  header.className = "dw-context-header";
  header.textContent = "上下文组成";
  const refreshBtn = document.createElement("button");
  refreshBtn.className = "dw-btn dw-btn-small";
  refreshBtn.textContent = "刷新";
  refreshBtn.addEventListener("click", () => void controller.refresh());
  header.appendChild(refreshBtn);
  root.appendChild(header);

  const toggleList = document.createElement("div");
  toggleList.className = "dw-context-toggles";
  root.appendChild(toggleList);

  const manifestBox = document.createElement("div");
  manifestBox.className = "dw-context-manifest";
  root.appendChild(manifestBox);
  container.appendChild(root);

  function render(): void {
    const { policy, manifest } = controller.current;

    toggleList.textContent = "";
    for (const type of TYPE_ORDER) {
      const row = document.createElement("label");
      row.className = "dw-context-toggle";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = policy?.[type] ?? false;
      checkbox.addEventListener("change", () => void controller.setEnabled(type, checkbox.checked));
      const name = document.createElement("span");
      name.textContent = TYPE_LABELS[type];
      row.append(checkbox, name);
      toggleList.appendChild(row);
    }

    manifestBox.textContent = "";
    if (manifest === null) {
      const empty = document.createElement("div");
      empty.className = "dw-context-empty";
      empty.textContent = "尚无请求：发送一条消息后此处展示当次请求的完整上下文清单。";
      manifestBox.appendChild(empty);
      return;
    }
    const meta = document.createElement("div");
    meta.className = "dw-context-meta";
    meta.textContent = `${manifest.model} · 总计 ${manifest.totalTokens} tokens · ${manifest.timestamp}`;
    manifestBox.appendChild(meta);
    for (const item of manifest.items) {
      const row = document.createElement("div");
      row.className = "dw-context-item";
      if (!item.enabled) {
        row.classList.add("dw-context-item-off");
      }
      const title = document.createElement("div");
      title.className = "dw-context-item-title";
      const countingMark = item.counting === "estimated" ? "（估算）" : "";
      title.textContent = `${item.enabled ? "●" : "○"} ${item.label} — ${item.tokens} tokens${countingMark}`;
      row.appendChild(title);
      if (item.enabled && item.content.length > 0) {
        const detail = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = "内容";
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
  void controller.refresh();
  render();

  return {
    root,
    dispose(): void {
      unsubscribe();
      root.remove();
    },
  };
}
