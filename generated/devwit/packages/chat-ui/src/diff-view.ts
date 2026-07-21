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
  header.textContent = options.title ?? "变更审查";
  root.appendChild(header);

  const body = document.createElement("div");
  body.className = "dw-diff-body";
  root.appendChild(body);

  const footer = document.createElement("div");
  footer.className = "dw-diff-footer";
  const acceptAllBtn = document.createElement("button");
  acceptAllBtn.className = "dw-btn dw-btn-small";
  acceptAllBtn.textContent = "全部接受";
  const rejectAllBtn = document.createElement("button");
  rejectAllBtn.className = "dw-btn dw-btn-small";
  rejectAllBtn.textContent = "全部拒绝";
  const applyBtn = document.createElement("button");
  applyBtn.className = "dw-btn dw-btn-small dw-btn-primary";
  applyBtn.textContent = "应用并关闭";
  const closeBtn = document.createElement("button");
  closeBtn.className = "dw-btn dw-btn-small";
  closeBtn.textContent = "取消";
  const progress = document.createElement("span");
  progress.className = "dw-diff-progress";
  footer.append(acceptAllBtn, rejectAllBtn, applyBtn, closeBtn, progress);
  root.appendChild(footer);
  container.appendChild(root);

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
      label.textContent = `变更块 #${hunk.id}（第 ${hunk.startLine} 行起）`;
      hunkHeader.appendChild(label);
      const acceptBtn = document.createElement("button");
      acceptBtn.className = "dw-btn dw-btn-tiny";
      acceptBtn.textContent = "接受";
      acceptBtn.addEventListener("click", () => controller.accept(hunk.id));
      const rejectBtn = document.createElement("button");
      rejectBtn.className = "dw-btn dw-btn-tiny";
      rejectBtn.textContent = "拒绝";
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
    progress.textContent = `${decided}/${controller.hunks.length} 已裁决`;
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
  render();

  return {
    root,
    dispose(): void {
      unsubscribe();
      root.remove();
    },
  };
}
