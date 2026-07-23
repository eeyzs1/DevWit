import { onDidChangeLocale, t } from "@devwit/i18n";
import type { DiffController } from "./diff-controller.js";

/**
 * diff-view DOM 视图（WU013 / AC3）：编辑器区域内的逐块 diff 审查。
 * - 每个 hunk（变更块）独立 接受 / 拒绝；context 行只读展示；
 * - 底部 全部接受 / 全部拒绝 / 应用并关闭；全部裁决完成后才可应用；
 * - 应用：onApply(controller.result()) 由集成方写回 editor-core 缓冲区（undoable）。
 */
export interface DiffViewOptions {
  controller: DiffController;
  /** 应用最终文本（集成方写回文档并可选保存）。 */
  onApply(finalText: string): void;
  /** 放弃审查（不改动文档）。 */
  onClose(): void;
  /** 标题（如目标文件路径）。 */
  title?: string;
}

export interface DiffViewHandle {
  readonly root: HTMLElement;
  dispose(): void;
}

export function mountDiffView(container: HTMLElement, options: DiffViewOptions): DiffViewHandle {
  const { controller } = options;
  const root = document.createElement("div");
  root.className = "dw-diff";

  const header = document.createElement("div");
  header.className = "dw-diff-header";
  header.textContent = options.title ?? t("diff.title");
  root.appendChild(header);

  const body = document.createElement("div");
  body.className = "dw-diff-body";
  root.appendChild(body);

  const footer = document.createElement("div");
  footer.className = "dw-diff-footer";
  const acceptAllBtn = document.createElement("button");
  acceptAllBtn.className = "dw-btn dw-btn-small";
  const rejectAllBtn = document.createElement("button");
  rejectAllBtn.className = "dw-btn dw-btn-small";
  const applyBtn = document.createElement("button");
  applyBtn.className = "dw-btn dw-btn-small dw-btn-primary";
  const closeBtn = document.createElement("button");
  closeBtn.className = "dw-btn dw-btn-small";
  const progress = document.createElement("span");
  progress.className = "dw-diff-progress";
  footer.append(acceptAllBtn, rejectAllBtn, applyBtn, closeBtn, progress);
  root.appendChild(footer);
  container.appendChild(root);

  /** 静态文案随语言热更新（AC12）。 */
  function applyLocale(): void {
    acceptAllBtn.textContent = t("diff.acceptAll");
    rejectAllBtn.textContent = t("diff.rejectAll");
    applyBtn.textContent = t("diff.apply");
    closeBtn.textContent = t("diff.cancel");
  }

  function render(): void {
    body.textContent = "";
    for (const segment of controller.segments) {
      if (segment.kind === "context") {
        for (const text of segment.lines) {
          const line = document.createElement("div");
          line.className = "dw-diff-line dw-diff-context";
          line.textContent = `  ${text}`;
          body.appendChild(line);
        }
        continue;
      }
      const hunk = segment.hunk;
      const hunkBox = document.createElement("div");
      hunkBox.className = `dw-diff-hunk dw-diff-hunk-${hunk.decision}`;
      const hunkHeader = document.createElement("div");
      hunkHeader.className = "dw-diff-hunk-header";
      const label = document.createElement("span");
      label.textContent = t("diff.hunk", { id: hunk.id, line: hunk.startLine });
      hunkHeader.appendChild(label);
      const acceptBtn = document.createElement("button");
      acceptBtn.className = "dw-btn dw-btn-tiny";
      acceptBtn.textContent = t("diff.accept");
      acceptBtn.addEventListener("click", () => controller.accept(hunk.id));
      const rejectBtn = document.createElement("button");
      rejectBtn.className = "dw-btn dw-btn-tiny";
      rejectBtn.textContent = t("diff.reject");
      rejectBtn.addEventListener("click", () => controller.reject(hunk.id));
      hunkHeader.append(acceptBtn, rejectBtn);
      hunkBox.appendChild(hunkHeader);
      for (const line of hunk.lines) {
        const row = document.createElement("div");
        row.className = line.kind === "add" ? "dw-diff-line dw-diff-add" : "dw-diff-line dw-diff-remove";
        row.textContent = `${line.kind === "add" ? "+" : "-"} ${line.text}`;
        hunkBox.appendChild(row);
      }
      body.appendChild(hunkBox);
    }

    const decided = controller.hunks.filter((hunk) => hunk.decision !== "pending").length;
    progress.textContent = t("diff.progress", { decided, total: controller.hunks.length });
    applyBtn.disabled = !controller.allDecided;
  }

  acceptAllBtn.addEventListener("click", () => controller.acceptAll());
  rejectAllBtn.addEventListener("click", () => controller.rejectAll());
  applyBtn.addEventListener("click", () => {
    if (controller.allDecided) {
      options.onApply(controller.result());
    }
  });
  closeBtn.addEventListener("click", () => options.onClose());

  const unsubscribe = controller.onChange(render);
  // 语言热生效（AC12）：按钮/hunk 标签/进度按新语言重绘
  const unsubscribeLocale = onDidChangeLocale(() => {
    applyLocale();
    render();
  });
  applyLocale();
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
