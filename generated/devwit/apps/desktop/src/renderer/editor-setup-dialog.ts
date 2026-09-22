/**
 * 外部编辑器引导小页（迭代 4 / 用户反馈 3）。
 *
 * 触发时机：未配置外部编辑器时点击「外部编辑器 ↗」（无论是否已打开文件），
 * 或外部编辑器启动失败需要修正命令模板。
 * 与完整设置页的关系：这是聚焦单一任务的小页面——预设一键填入命令模板，
 * 保存即热生效；若有待打开的文件，「保存并打开」保存后立即重试打开。
 */
import type { DevwitApi } from "@devwit/contracts";
import { t } from "@devwit/i18n";

/** 常用编辑器预设（设置页编辑器分区共用此表）。 */
export const EXTERNAL_EDITOR_PRESETS: ReadonlyArray<{ label: string; command: string }> = [
  { label: "VS Code", command: 'code -g "{file}:{line}"' },
  { label: "Cursor", command: 'cursor -g "{file}:{line}"' },
  { label: "Sublime Text", command: 'subl "{file}:{line}"' },
  { label: "Notepad++", command: 'notepad++ "{file}"' },
  { label: "JetBrains IDEA", command: 'idea "{file}"' },
];

export interface EditorSetupDialogDeps {
  api: DevwitApi;
  /** 「保存并打开」回调（有待打开文件时由调用方传入，保存成功后重试打开）。 */
  onSaved?: () => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function openEditorSetupDialog(deps: EditorSetupDialogDeps): void {
  // 防重复弹出（如启动失败重试路径与手动点击同时触发）
  if (document.querySelector(".dw-editor-setup-mask") !== null) return;

  const mask = el("div", "dw-modal-mask dw-editor-setup-mask");
  const modal = el("div", "dw-modal dw-editor-setup");
  mask.appendChild(modal);
  modal.appendChild(el("h2", undefined, t("editorSetup.title")));
  modal.appendChild(el("p", "dw-modal-hint", t("editorSetup.desc")));

  // 常用编辑器预设：点选即填入命令模板；「自定义」仅聚焦输入框
  const presets = el("div", "dw-modal-actions");
  const commandInput = el("input", "dw-input") as HTMLInputElement;
  commandInput.placeholder = t("editor.command.placeholder");
  for (const preset of EXTERNAL_EDITOR_PRESETS) {
    const btn = el("button", "dw-btn dw-btn-small", preset.label);
    btn.addEventListener("click", () => {
      commandInput.value = preset.command;
      commandInput.focus();
    });
    presets.appendChild(btn);
  }
  const customBtn = el("button", "dw-btn dw-btn-small", t("editorSetup.custom"));
  customBtn.addEventListener("click", () => commandInput.focus());
  presets.appendChild(customBtn);
  modal.appendChild(presets);

  modal.appendChild(el("label", undefined, t("editorSetup.command")));
  modal.appendChild(commandInput);
  modal.appendChild(el("p", "dw-modal-hint", t("editor.hint")));
  const errorBox = el("div", "dw-form-error");
  modal.appendChild(errorBox);

  // 预填当前配置（启动失败修正路径：把用户现有模板带出来改）。
  // v0.7.27（审查 R8-9）：仅空时回填——迟到 resolve 不覆写用户已选的预设模板
  void deps.api.settings.get("externalEditor").then((value) => {
    const config = value as { command?: string } | null;
    if (config !== null && typeof config.command === "string" && commandInput.value === "") {
      commandInput.value = config.command;
    }
  });

  // v0.7.27（审查 R8-4）：成功提示独立元素（accent 色）——旧实现复用
  // .dw-form-error 红色样式显示「已保存」，用户误以为保存失败
  const okBox = el("div", "dw-form-ok");
  modal.appendChild(okBox);

  const close = (): void => mask.remove();
  async function save(): Promise<boolean> {
    okBox.textContent = "";
    const command = commandInput.value.trim();
    if (command === "") {
      errorBox.textContent = t("err.templateEmpty");
      return false;
    }
    if (!command.includes("{file}")) {
      errorBox.textContent = t("editor.missingFile");
      return false;
    }
    await deps.api.settings.set("externalEditor", { command });
    return true;
  }

  const actions = el("div", "dw-modal-actions");
  const cancelBtn = el("button", "dw-btn", t("common.cancel"));
  cancelBtn.addEventListener("click", close);
  actions.appendChild(cancelBtn);
  const saveBtn = el("button", "dw-btn", t("editorSetup.save"));
  saveBtn.addEventListener("click", () => {
    errorBox.textContent = "";
    void save()
      .then((ok) => {
        if (ok) okBox.textContent = t("editor.saved");
      })
      .catch(() => undefined); // v0.7.27（R8-5）：IPC 失败不静默 unhandled rejection
  });
  actions.appendChild(saveBtn);
  if (deps.onSaved !== undefined) {
    const saveOpenBtn = el("button", "dw-btn dw-btn-primary", t("editorSetup.saveOpen"));
    saveOpenBtn.addEventListener("click", () => {
      errorBox.textContent = "";
      void save()
        .then((ok) => {
          if (!ok) return;
          close();
          deps.onSaved?.();
        })
        .catch(() => undefined); // v0.7.27（R8-5）
    });
    actions.appendChild(saveOpenBtn);
  }
  modal.appendChild(actions);

  mask.addEventListener("click", (event) => {
    if (event.target === mask) close();
  });
  // v0.7.29（R8-10 a11y）：Escape 关闭（不保存——与取消同语义）
  mask.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  });
  document.body.appendChild(mask);
  commandInput.focus();
}
