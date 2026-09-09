/**
 * LSP 代码智能 UI 集群（v0.4.0 → v0.7.6 自 index.ts 抽取为模块）。
 *
 * 覆盖：状态条渲染、诊断波浪线、didOpen/didChange 同步、悬停浮层、
 * Ctrl+Click 跳转定义、自动补全、引用查找（Shift+F12）、签名帮助、
 * 重命名（F2）、代码操作（Ctrl+.）、文档大纲树。
 * 依赖经 LspUiDeps 注入（宿主持有 editor/openFile/workspaceRoot 状态）；
 * LSP 状态与诊断数据由本模块持有并订阅（唯一事实源）。
 */
import type {
  DevwitApi,
  LspCodeAction,
  LspCompletionItem,
  LspDefinitionTarget,
  LspDiagnosticItem,
  LspDocumentSymbol,
  LspSignatureHelp,
  LspStatusInfo,
  LspTextEdit,
} from "@devwit/contracts";
import type { TextDocument } from "@devwit/editor-core";
import type { EditorView } from "@devwit/editor-render";
import { t } from "@devwit/i18n";
import { el } from "./dom.js";

/** 模块视角的活动文件（结构子集——宿主 OpenFile 满足此形状即可）。 */
export interface LspOpenFileView {
  path: string;
  doc: TextDocument;
}

export interface LspUiDeps {
  api: DevwitApi;
  editor: EditorView;
  canvas: HTMLCanvasElement;
  /** 弹层挂载容器（定位参照系）。 */
  editorArea: HTMLElement;
  /** 左栏大纲面板。 */
  outlinePane: HTMLElement;
  /** 状态条 LSP 段。 */
  statusLsp: HTMLElement;
  getWorkspaceRoot(): string;
  getOpenFile(): LspOpenFileView | null;
  /** 绝对路径 → 工作区相对路径（正斜杠）。 */
  relPathOf(absPath: string): string;
  openFileByPath(path: string): Promise<void>;
}

export interface LspUiHandle {
  renderLspStatus(): void;
  applyEditorDiagnostics(): void;
  syncOpenFileToLsp(): void;
  scheduleLspSync(): void;
  hideCompletion(): void;
  scheduleCompletion(): void;
  scheduleOutlineRefresh(): void;
  refreshOutline(): Promise<void>;
  renderOutlineTree(): void;
}

/** 跨文件 LSP 编辑应用：当前文件走 doc.applyEdit（倒序 offset），其余 read→改→write。 */
async function applyCrossFileEdits(
  api: DevwitApi,
  current: LspOpenFileView,
  currentRel: string,
  root: string,
  edits: LspTextEdit[]
): Promise<void> {
  const byFile = new Map<string, LspTextEdit[]>();
  for (const edit of edits) {
    const arr = byFile.get(edit.file) ?? [];
    arr.push(edit);
    byFile.set(edit.file, arr);
  }
  for (const [file, fileEdits] of byFile) {
    if (file === currentRel) {
      const doc = current.doc;
      const sorted = fileEdits.slice().sort((a, b) => {
        const ao = doc.offsetAt({ line: a.startLine, character: a.startCharacter });
        const bo = doc.offsetAt({ line: b.startLine, character: b.startCharacter });
        return bo - ao;
      });
      for (const edit of sorted) {
        const startOffset = doc.offsetAt({ line: edit.startLine, character: edit.startCharacter });
        const endOffset = doc.offsetAt({ line: edit.endLine, character: edit.endCharacter });
        doc.applyEdit({ offset: startOffset, length: endOffset - startOffset, text: edit.newText });
      }
    } else {
      const abs = `${root}/${file}`;
      try {
        const content = await api.workspace.read(abs);
        const lineStarts: number[] = [0];
        for (let i = 0; i < content.length; i++) {
          if (content[i] === "\n") lineStarts.push(i + 1);
        }
        const sorted = fileEdits.slice().sort((a, b) => {
          const ao = (lineStarts[a.startLine] ?? 0) + a.startCharacter;
          const bo = (lineStarts[b.startLine] ?? 0) + b.startCharacter;
          return bo - ao;
        });
        let text = content;
        for (const edit of sorted) {
          const startOffset = (lineStarts[edit.startLine] ?? 0) + edit.startCharacter;
          const endOffset = (lineStarts[edit.endLine] ?? 0) + edit.endCharacter;
          text = text.slice(0, startOffset) + edit.newText + text.slice(endOffset);
        }
        await api.workspace.write(abs, text);
      } catch {
        // 读取/写入失败：跳过该文件（跨文件编辑容错）
      }
    }
  }
}

export function mountLspUi(deps: LspUiDeps): LspUiHandle {
  const { api, editor, canvas, editorArea, outlinePane, statusLsp } = deps;
  let lspStatus: LspStatusInfo = { state: "idle" };
  let lspDiags: LspDiagnosticItem[] = [];

  function renderLspStatus(): void {
    if (lspStatus.state === "idle") {
      statusLsp.textContent = "";
      return;
    }
    if (lspStatus.state === "starting") {
      statusLsp.textContent = t("lsp.status.starting");
      return;
    }
    if (lspStatus.state === "error") {
      statusLsp.textContent = t("lsp.status.error", { code: lspStatus.code });
      return;
    }
    const errors = lspDiags.filter((d) => d.severity === "error").length;
    const warnings = lspDiags.filter((d) => d.severity === "warning").length;
    statusLsp.textContent = t("lsp.diag.count", { errors: String(errors), warnings: String(warnings) });
  }

  /** 当前文件波浪线（诊断推送与文件切换共用；只取当前文件的诊断）。 */
  function applyEditorDiagnostics(): void {
    const openFile = deps.getOpenFile();
    if (openFile === null || deps.getWorkspaceRoot() === "") {
      editor.setDiagnostics([]);
      return;
    }
    const rel = deps.relPathOf(openFile.path);
    editor.setDiagnostics(lspDiags.filter((d) => d.file === rel));
  }

  /** 活动文档同步给 tsserver（didOpen 全文；服务器未就绪时主进程丢弃，ready 推送时补偿重放）。 */
  function syncOpenFileToLsp(): void {
    const openFile = deps.getOpenFile();
    if (openFile === null || deps.getWorkspaceRoot() === "") return;
    void api.lsp.didOpen(deps.relPathOf(openFile.path), openFile.doc.getText());
  }

  // didChange 防抖 300ms（编辑器缓冲区即事实源，Full 同步语义，未保存内容参与分析）
  let lspSyncTimer: number | undefined;
  function scheduleLspSync(): void {
    window.clearTimeout(lspSyncTimer);
    lspSyncTimer = window.setTimeout(() => {
      const openFile = deps.getOpenFile();
      if (openFile !== null && deps.getWorkspaceRoot() !== "") {
        void api.lsp.didChange(deps.relPathOf(openFile.path), openFile.doc.getText());
      }
    }, 300);
  }

  // 悬停浮层：鼠标驻留 500ms → IPC hover → DOM tooltip；移动/输入/点击/Esc/滚动关闭
  const hoverTip = el("div", "dw-lsp-hover");
  hoverTip.style.display = "none";
  editorArea.appendChild(hoverTip);
  let hoverTimer: number | undefined;
  function hideHover(): void {
    window.clearTimeout(hoverTimer);
    hoverTip.style.display = "none";
  }
  async function showHoverAt(clientX: number, clientY: number): Promise<void> {
    const current = deps.getOpenFile();
    if (current === null || deps.getWorkspaceRoot() === "" || lspStatus.state !== "ready") return;
    const pos = editor.positionFromClientPoint(clientX, clientY);
    const info = await api.lsp.hover(deps.relPathOf(current.path), pos.line, pos.character);
    // 驻留期间文件已切换 → 丢弃迟到响应
    if (deps.getOpenFile() !== current || info === null || info.text.trim() === "") return;
    const areaRect = editorArea.getBoundingClientRect();
    hoverTip.textContent = info.text;
    hoverTip.style.left = `${clientX - areaRect.left + 14}px`;
    hoverTip.style.top = `${clientY - areaRect.top + 18}px`;
    hoverTip.style.display = "block";
  }
  canvas.addEventListener("mousemove", (ev) => {
    hideHover(); // 任何移动先关闭旧浮层并重置驻留计时
    if (deps.getOpenFile() === null || lspStatus.state !== "ready") return;
    const { clientX, clientY } = ev;
    hoverTimer = window.setTimeout(() => void showHoverAt(clientX, clientY), 500);
  });
  canvas.addEventListener("mouseleave", hideHover);
  canvas.addEventListener("mousedown", hideHover);
  canvas.addEventListener("wheel", hideHover);
  window.addEventListener("keydown", hideHover);

  // Ctrl/Cmd+Click 跳转定义：同文件 revealPosition；跨文件打开后定位（0-based 行列直传）
  editor.onDefinitionRequest = (pos) => {
    const current = deps.getOpenFile();
    if (current === null || deps.getWorkspaceRoot() === "" || lspStatus.state !== "ready") return;
    const currentRel = deps.relPathOf(current.path);
    void (async () => {
      const targets = await api.lsp.definition(currentRel, pos.line, pos.character);
      const target = targets[0];
      if (target === undefined) return;
      if (target.file === currentRel && deps.getOpenFile() === current) {
        editor.revealPosition({ line: target.line, character: target.character });
      } else {
        const abs = `${deps.getWorkspaceRoot().replace(/[/\\]+$/, "")}/${target.file}`;
        await deps.openFileByPath(abs);
        editor.revealPosition({ line: target.line, character: target.character });
      }
    })();
  };

  // ---- LSP 自动补全（v0.4.0）：输入触发 → IPC completion → 浮层 → 键盘/鼠标选择 ----
  const completionPopup = el("div", "dw-completion");
  completionPopup.style.display = "none";
  editorArea.appendChild(completionPopup);
  let completionItems: LspCompletionItem[] = [];
  let completionIndex = 0;
  let completionVisible = false;
  let completionTimer: number | undefined;
  let completionToken = 0; // 竞态保护：迟到响应丢弃

  function hideCompletion(): void {
    window.clearTimeout(completionTimer);
    completionPopup.style.display = "none";
    completionVisible = false;
    completionItems = [];
    completionIndex = 0;
  }

  /** 当前光标位置的单词起始列（标识符字符 [a-zA-Z0-9_$] 回扫）。 */
  function wordStartCharAt(line: number, character: number): number {
    const text = deps.getOpenFile()?.doc.getLine(line) ?? "";
    let i = character;
    while (i > 0 && /[a-zA-Z0-9_$]/.test(text[i - 1]!)) i--;
    return i;
  }

  function renderCompletionPopup(): void {
    if (completionItems.length === 0 || deps.getOpenFile() === null) {
      hideCompletion();
      return;
    }
    const items = completionItems.slice(0, 50); // 上限 50 防巨列表
    completionPopup.innerHTML = "";
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const row = el("div", "dw-completion-item");
      if (i === completionIndex) row.classList.add("dw-completion-active");
      const label = el("span", "dw-completion-label");
      label.textContent = item.label;
      row.appendChild(label);
      if (item.detail) {
        const detail = el("span", "dw-completion-detail");
        detail.textContent = item.detail;
        row.appendChild(detail);
      }
      row.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        completionIndex = i;
        applyCompletion();
      });
      completionPopup.appendChild(row);
    }
    // 定位浮层到光标下方
    const sel = editor.getSelections().at(-1);
    if (sel !== undefined) {
      const pt = editor.clientPointForPosition(sel.active);
      const areaRect = editorArea.getBoundingClientRect();
      completionPopup.style.left = `${pt.x - areaRect.left}px`;
      completionPopup.style.top = `${pt.y - areaRect.top + 18}px`;
    }
    completionPopup.style.display = "block";
    completionVisible = true;
  }

  async function requestCompletion(): Promise<void> {
    const current = deps.getOpenFile();
    if (current === null || deps.getWorkspaceRoot() === "" || lspStatus.state !== "ready") return;
    const sel = editor.getSelections().at(-1);
    if (sel === undefined) return;
    const pos = sel.active;
    const token = ++completionToken;
    const items = await api.lsp.completion(deps.relPathOf(current.path), pos.line, pos.character);
    // 迟到响应丢弃（文件已切换或光标已移动）
    if (completionToken !== token || deps.getOpenFile() !== current) return;
    const after = editor.getSelections().at(-1);
    if (after === undefined || after.active.line !== pos.line || after.active.character !== pos.character) return;
    completionItems = items;
    completionIndex = 0;
    renderCompletionPopup();
  }

  function scheduleCompletion(): void {
    if (deps.getOpenFile() === null || deps.getWorkspaceRoot() === "" || lspStatus.state !== "ready") return;
    window.clearTimeout(completionTimer);
    completionTimer = window.setTimeout(() => void requestCompletion(), 250);
  }

  /** 应用选中的补全项：替换单词范围为 insertText（缺省 label）。 */
  function applyCompletion(): void {
    if (!completionVisible || completionItems.length === 0) return;
    const item = completionItems[completionIndex];
    const openFile = deps.getOpenFile();
    if (item === undefined || openFile === null) return;
    const sel = editor.getSelections().at(-1);
    if (sel === undefined) return;
    const pos = sel.active;
    const startChar = wordStartCharAt(pos.line, pos.character);
    const text = item.insertText ?? item.label;
    const startOffset = openFile.doc.offsetAt({ line: pos.line, character: startChar });
    const endOffset = openFile.doc.offsetAt({ line: pos.line, character: pos.character });
    openFile.doc.applyEdit({ offset: startOffset, length: endOffset - startOffset, text });
    const newPos = openFile.doc.positionAt(startOffset + text.length);
    editor.revealPosition(newPos);
    hideCompletion();
  }

  // 键盘导航：浮层可见时拦截 ArrowUp/Down/Enter/Tab/Esc（capture 阶段先于编辑器）
  window.addEventListener("keydown", (ev) => {
    if (!completionVisible) return;
    const count = Math.min(completionItems.length, 50);
    switch (ev.key) {
      case "ArrowDown":
        ev.preventDefault();
        ev.stopPropagation();
        completionIndex = (completionIndex + 1) % count;
        renderCompletionPopup();
        break;
      case "ArrowUp":
        ev.preventDefault();
        ev.stopPropagation();
        completionIndex = (completionIndex - 1 + count) % count;
        renderCompletionPopup();
        break;
      case "Enter":
      case "Tab":
        ev.preventDefault();
        ev.stopPropagation();
        applyCompletion();
        break;
      case "Escape":
        ev.preventDefault();
        ev.stopPropagation();
        hideCompletion();
        break;
    }
  }, true);
  canvas.addEventListener("mousedown", hideCompletion);

  // ---- LSP 引用查找（v0.4.0）：Shift+F12 触发 → IPC references → 浮层列表 → 跳转 ----
  const referencesPopup = el("div", "dw-references");
  referencesPopup.style.display = "none";
  editorArea.appendChild(referencesPopup);
  let referencesItems: LspDefinitionTarget[] = [];
  let referencesIndex = 0;
  let referencesVisible = false;
  let referencesToken = 0;

  function hideReferences(): void {
    referencesPopup.style.display = "none";
    referencesVisible = false;
    referencesItems = [];
    referencesIndex = 0;
  }

  function positionReferencesPopup(): void {
    const sel = editor.getSelections().at(-1);
    if (sel !== undefined) {
      const pt = editor.clientPointForPosition(sel.active);
      const areaRect = editorArea.getBoundingClientRect();
      referencesPopup.style.left = `${pt.x - areaRect.left}px`;
      referencesPopup.style.top = `${pt.y - areaRect.top + 18}px`;
    }
  }

  function renderReferencesPopup(): void {
    const openFile = deps.getOpenFile();
    if (referencesItems.length === 0 || openFile === null) {
      hideReferences();
      return;
    }
    const items = referencesItems.slice(0, 50);
    referencesPopup.innerHTML = "";
    const header = el("div", "dw-references-header");
    header.textContent = t("lsp.references.count", { n: items.length });
    referencesPopup.appendChild(header);
    const currentRel = deps.relPathOf(openFile.path);
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const row = el("div", "dw-references-item");
      if (i === referencesIndex) row.classList.add("dw-references-active");
      const loc = el("span", "dw-references-loc");
      loc.textContent = `${item.file}:${item.line + 1}:${item.character + 1}`;
      row.appendChild(loc);
      if (item.file === currentRel) {
        const lineText = openFile.doc.getLine(item.line) ?? "";
        const preview = el("span", "dw-references-preview");
        preview.textContent = lineText.trim().slice(0, 60);
        row.appendChild(preview);
      }
      row.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        referencesIndex = i;
        applyReferences();
      });
      referencesPopup.appendChild(row);
    }
    positionReferencesPopup();
    referencesPopup.style.display = "block";
    referencesVisible = true;
  }

  async function requestReferences(): Promise<void> {
    const current = deps.getOpenFile();
    if (current === null || deps.getWorkspaceRoot() === "" || lspStatus.state !== "ready") return;
    const sel = editor.getSelections().at(-1);
    if (sel === undefined) return;
    const pos = sel.active;
    const token = ++referencesToken;
    const items = await api.lsp.references(deps.relPathOf(current.path), pos.line, pos.character);
    if (referencesToken !== token || deps.getOpenFile() !== current) return;
    if (items.length === 0) {
      referencesPopup.innerHTML = "";
      const empty = el("div", "dw-references-empty");
      empty.textContent = t("lsp.references.empty");
      referencesPopup.appendChild(empty);
      positionReferencesPopup();
      referencesPopup.style.display = "block";
      referencesVisible = true;
      window.setTimeout(hideReferences, 1500);
      return;
    }
    referencesItems = items;
    referencesIndex = 0;
    renderReferencesPopup();
  }

  function applyReferences(): void {
    if (!referencesVisible || referencesItems.length === 0) return;
    const target = referencesItems[referencesIndex];
    if (target === undefined) return;
    const current = deps.getOpenFile();
    const currentRel = current !== null ? deps.relPathOf(current.path) : "";
    hideReferences();
    if (target.file === currentRel && current !== null) {
      editor.revealPosition({ line: target.line, character: target.character });
    } else {
      const abs = `${deps.getWorkspaceRoot().replace(/[/\\]+$/, "")}/${target.file}`;
      void deps.openFileByPath(abs).then(() => {
        editor.revealPosition({ line: target.line, character: target.character });
      });
    }
  }

  window.addEventListener("keydown", (ev) => {
    if (ev.shiftKey && ev.key === "F12") {
      ev.preventDefault();
      ev.stopPropagation();
      void requestReferences();
      return;
    }
    if (!referencesVisible) return;
    const count = Math.min(referencesItems.length, 50);
    switch (ev.key) {
      case "ArrowDown":
        ev.preventDefault();
        ev.stopPropagation();
        referencesIndex = (referencesIndex + 1) % count;
        renderReferencesPopup();
        break;
      case "ArrowUp":
        ev.preventDefault();
        ev.stopPropagation();
        referencesIndex = (referencesIndex - 1 + count) % count;
        renderReferencesPopup();
        break;
      case "Enter":
        ev.preventDefault();
        ev.stopPropagation();
        applyReferences();
        break;
      case "Escape":
        ev.preventDefault();
        ev.stopPropagation();
        hideReferences();
        break;
    }
  }, true);
  canvas.addEventListener("mousedown", hideReferences);

  // ---- LSP 签名帮助（v0.4.0）：输入 ( 或 , 触发 → IPC signatureHelp → 浮层显示签名 + 当前参数高亮 ----
  const signaturePopup = el("div", "dw-signature");
  signaturePopup.style.display = "none";
  editorArea.appendChild(signaturePopup);
  let signatureVisible = false;
  let signatureToken = 0;

  function hideSignature(): void {
    signaturePopup.style.display = "none";
    signatureVisible = false;
  }

  function renderSignaturePopup(data: LspSignatureHelp): void {
    const sig = data.signatures[data.activeSignature] ?? data.signatures[0];
    if (sig === undefined) {
      hideSignature();
      return;
    }
    signaturePopup.innerHTML = "";
    const label = el("div", "dw-signature-label");
    const activeParam = sig.parameters[data.activeParameter];
    if (activeParam !== undefined && activeParam.label.length > 0 && sig.label.includes(activeParam.label)) {
      const idx = sig.label.indexOf(activeParam.label);
      label.textContent = sig.label.slice(0, idx);
      const bold = el("b", "dw-signature-active");
      bold.textContent = activeParam.label;
      label.appendChild(bold);
      label.appendChild(document.createTextNode(sig.label.slice(idx + activeParam.label.length)));
    } else {
      label.textContent = sig.label;
    }
    signaturePopup.appendChild(label);
    if (activeParam?.documentation) {
      const doc = el("div", "dw-signature-doc");
      doc.textContent = activeParam.documentation;
      signaturePopup.appendChild(doc);
    }
    const sel = editor.getSelections().at(-1);
    if (sel !== undefined) {
      const pt = editor.clientPointForPosition(sel.active);
      const areaRect = editorArea.getBoundingClientRect();
      signaturePopup.style.left = `${pt.x - areaRect.left}px`;
      signaturePopup.style.top = `${pt.y - areaRect.top + 18}px`;
    }
    signaturePopup.style.display = "block";
    signatureVisible = true;
  }

  async function requestSignature(): Promise<void> {
    const current = deps.getOpenFile();
    if (current === null || deps.getWorkspaceRoot() === "" || lspStatus.state !== "ready") return;
    const sel = editor.getSelections().at(-1);
    if (sel === undefined) return;
    const pos = sel.active;
    const token = ++signatureToken;
    const data = await api.lsp.signatureHelp(deps.relPathOf(current.path), pos.line, pos.character);
    if (signatureToken !== token || deps.getOpenFile() !== current) return;
    if (data === null) {
      hideSignature();
      return;
    }
    renderSignaturePopup(data);
  }

  window.addEventListener("keydown", (ev) => {
    if (ev.key === "(" || ev.key === ",") {
      if (deps.getOpenFile() !== null) window.setTimeout(() => void requestSignature(), 50);
      return;
    }
    if (ev.key === ")") {
      hideSignature();
      return;
    }
    if (ev.key === "Escape" && signatureVisible) {
      ev.preventDefault();
      ev.stopPropagation();
      hideSignature();
    }
  }, true);
  canvas.addEventListener("mousedown", hideSignature);

  // ---- LSP 符号重命名（v0.4.0）：F2 触发 → 输入框 → 调用 rename → 跨文件应用编辑 ----
  const renameBox = el("div", "dw-rename");
  renameBox.style.display = "none";
  editorArea.appendChild(renameBox);
  const renameInput = document.createElement("input");
  renameInput.type = "text";
  renameInput.className = "dw-rename-input";
  renameInput.placeholder = "New name";
  renameBox.appendChild(renameInput);
  let renameVisible = false;
  let renameToken = 0;

  function hideRename(): void {
    renameBox.style.display = "none";
    renameVisible = false;
    renameInput.value = "";
  }

  function showRenameBox(currentName: string): void {
    renameInput.value = currentName;
    const sel = editor.getSelections().at(-1);
    if (sel !== undefined) {
      const pt = editor.clientPointForPosition(sel.active);
      const areaRect = editorArea.getBoundingClientRect();
      renameBox.style.left = `${pt.x - areaRect.left}px`;
      renameBox.style.top = `${pt.y - areaRect.top + 18}px`;
    }
    renameBox.style.display = "block";
    renameVisible = true;
    renameInput.focus();
    renameInput.select();
  }

  async function applyRename(newName: string): Promise<void> {
    const current = deps.getOpenFile();
    if (current === null || deps.getWorkspaceRoot() === "" || lspStatus.state !== "ready") return;
    const sel = editor.getSelections().at(-1);
    if (sel === undefined) return;
    const pos = sel.active;
    const token = ++renameToken;
    const edits = await api.lsp.rename(deps.relPathOf(current.path), pos.line, pos.character, newName);
    if (renameToken !== token || deps.getOpenFile() !== current) return;
    hideRename();
    if (edits.length === 0) return;
    await applyCrossFileEdits(api, current, deps.relPathOf(current.path), deps.getWorkspaceRoot().replace(/[/\\]+$/, ""), edits);
  }

  window.addEventListener("keydown", (ev) => {
    if (ev.key === "F2" && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      const openFile = deps.getOpenFile();
      if (openFile === null || lspStatus.state !== "ready") return;
      ev.preventDefault();
      ev.stopPropagation();
      const sel = editor.getSelections().at(-1);
      if (sel === undefined) return;
      const pos = sel.active;
      const lineText = openFile.doc.getLine(pos.line) ?? "";
      let start = pos.character;
      let end = pos.character;
      while (start > 0 && /[\w$]/.test(lineText[start - 1] ?? "")) start--;
      while (end < lineText.length && /[\w$]/.test(lineText[end] ?? "")) end++;
      const currentName = lineText.slice(start, end);
      if (currentName.length === 0) return;
      showRenameBox(currentName);
      return;
    }
    if (!renameVisible) return;
    if (ev.key === "Enter") {
      ev.preventDefault();
      ev.stopPropagation();
      const newName = renameInput.value.trim();
      if (newName.length === 0) {
        hideRename();
        return;
      }
      void applyRename(newName);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      hideRename();
    }
  }, true);
  canvas.addEventListener("mousedown", hideRename);

  // ---- LSP 代码操作（v0.4.0）：Ctrl+. 触发 → 菜单浮层 → 选择 → 应用编辑 ----
  const codeActionPopup = el("div", "dw-code-action");
  codeActionPopup.style.display = "none";
  editorArea.appendChild(codeActionPopup);
  let codeActionItems: LspCodeAction[] = [];
  let codeActionIndex = 0;
  let codeActionVisible = false;
  let codeActionToken = 0;

  function hideCodeAction(): void {
    codeActionPopup.style.display = "none";
    codeActionVisible = false;
    codeActionItems = [];
    codeActionIndex = 0;
  }

  function renderCodeActionPopup(): void {
    if (codeActionItems.length === 0 || deps.getOpenFile() === null) {
      hideCodeAction();
      return;
    }
    codeActionPopup.innerHTML = "";
    for (let i = 0; i < codeActionItems.length; i++) {
      const item = codeActionItems[i]!;
      const row = el("div", "dw-code-action-item");
      if (i === codeActionIndex) row.classList.add("dw-code-action-active");
      const title = el("span", "dw-code-action-title");
      title.textContent = (item.isPreferred ? "★ " : "") + item.title;
      row.appendChild(title);
      if (item.kind) {
        const kind = el("span", "dw-code-action-kind");
        kind.textContent = item.kind;
        row.appendChild(kind);
      }
      row.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        codeActionIndex = i;
        void applyCodeAction();
      });
      codeActionPopup.appendChild(row);
    }
    const sel = editor.getSelections().at(-1);
    if (sel !== undefined) {
      const pt = editor.clientPointForPosition(sel.active);
      const areaRect = editorArea.getBoundingClientRect();
      codeActionPopup.style.left = `${pt.x - areaRect.left}px`;
      codeActionPopup.style.top = `${pt.y - areaRect.top + 18}px`;
    }
    codeActionPopup.style.display = "block";
    codeActionVisible = true;
  }

  async function applyCodeAction(): Promise<void> {
    if (!codeActionVisible || codeActionItems.length === 0) return;
    const action = codeActionItems[codeActionIndex];
    if (action === undefined) return;
    hideCodeAction();
    if (action.edits.length === 0) return; // 仅 command，暂不支持执行

    const current = deps.getOpenFile();
    if (current === null) return;
    await applyCrossFileEdits(api, current, deps.relPathOf(current.path), deps.getWorkspaceRoot().replace(/[/\\]+$/, ""), action.edits);
  }

  async function requestCodeAction(): Promise<void> {
    const current = deps.getOpenFile();
    if (current === null || deps.getWorkspaceRoot() === "" || lspStatus.state !== "ready") return;
    const sel = editor.getSelections().at(-1);
    if (sel === undefined) return;
    const pos = sel.active;
    const token = ++codeActionToken;
    const actions = await api.lsp.codeAction(deps.relPathOf(current.path), pos.line, pos.character, pos.line, pos.character);
    if (codeActionToken !== token || deps.getOpenFile() !== current) return;
    if (actions.length === 0) {
      hideCodeAction();
      return;
    }
    codeActionItems = actions;
    codeActionIndex = 0;
    renderCodeActionPopup();
  }

  window.addEventListener("keydown", (ev) => {
    if (ev.key === "." && ev.ctrlKey && !ev.shiftKey && !ev.metaKey && !ev.altKey) {
      if (deps.getOpenFile() === null || lspStatus.state !== "ready") return;
      ev.preventDefault();
      ev.stopPropagation();
      void requestCodeAction();
      return;
    }
    if (!codeActionVisible) return;
    switch (ev.key) {
      case "ArrowDown":
        ev.preventDefault();
        ev.stopPropagation();
        codeActionIndex = (codeActionIndex + 1) % codeActionItems.length;
        renderCodeActionPopup();
        break;
      case "ArrowUp":
        ev.preventDefault();
        ev.stopPropagation();
        codeActionIndex = (codeActionIndex - 1 + codeActionItems.length) % codeActionItems.length;
        renderCodeActionPopup();
        break;
      case "Enter":
        ev.preventDefault();
        ev.stopPropagation();
        void applyCodeAction();
        break;
      case "Escape":
        ev.preventDefault();
        ev.stopPropagation();
        hideCodeAction();
        break;
    }
  }, true);
  canvas.addEventListener("mousedown", hideCodeAction);

  // ---- LSP 文档大纲（v0.4.0）：textDocument/documentSymbol → 左栏树 → 点击跳转 ----
  let outlineSymbols: LspDocumentSymbol[] = [];
  let outlineToken = 0;
  /** 展开状态以「line:character:kind」签名记录（同文件内符号位置稳定即可） */
  const outlineCollapsed = new Set<string>();

  function outlineKey(s: LspDocumentSymbol): string {
    return `${s.line}:${s.character}:${s.kind}`;
  }

  /** 符号 kind → 图标字符（LSP SymbolKind 子集；缺省=•）。 */
  function outlineIcon(kind: number): string {
    switch (kind) {
      case 2: return "⊙"; // Module
      case 3: return "▣"; // Namespace
      case 4: return "_pkg"; // Package
      case 5: return "◯"; // Class
      case 6: return "ƒ"; // Method
      case 7: return "◇"; // Property
      case 8: return "▪"; // Field
      case 9: return "ctr"; // Constructor
      case 10: return "Enum"; // Enum
      case 11: return "I"; // Interface
      case 12: return "λ"; // Function
      case 13: return "var"; // Variable
      case 14: return "K"; // Constant
      case 15: return "S"; // String
      case 16: return "#"; // Number
      case 17: return "_BOOL"; // Boolean
      case 18: return "[]"; // Array
      case 19: return "{}"; // Object
      case 23: return "struct"; // Struct
      case 24: return "evt"; // Event
      case 25: return "op"; // Operator
      case 26: return "T"; // TypeParameter
      default: return "•";
    }
  }

  function renderOutlineTree(): void {
    outlinePane.innerHTML = "";
    if (outlineSymbols.length === 0) {
      outlinePane.appendChild(el("div", "dw-sidebar-empty", t("outline.empty")));
      return;
    }
    const root = el("div", "dw-outline-list");
    const renderNode = (sym: LspDocumentSymbol, depth: number): void => {
      const hasChildren = sym.children !== undefined && sym.children.length > 0;
      const key = outlineKey(sym);
      const collapsed = outlineCollapsed.has(key);
      const row = el("div", "dw-outline-item");
      row.style.paddingLeft = `${8 + depth * 14}px`;
      if (hasChildren) {
        const toggle = el("span", "dw-outline-toggle");
        toggle.textContent = collapsed ? "▸" : "▾";
        toggle.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (outlineCollapsed.has(key)) outlineCollapsed.delete(key);
          else outlineCollapsed.add(key);
          renderOutlineTree();
        });
        row.appendChild(toggle);
      } else {
        row.appendChild(el("span", "dw-outline-toggle dw-outline-toggle-leaf"));
      }
      const icon = el("span", "dw-outline-icon");
      icon.textContent = outlineIcon(sym.kind);
      row.appendChild(icon);
      const name = el("span", "dw-outline-name");
      if (sym.deprecated === true) name.classList.add("dw-outline-deprecated");
      name.textContent = sym.name;
      row.appendChild(name);
      if (sym.detail !== undefined && sym.detail !== "") {
        const detail = el("span", "dw-outline-detail");
        detail.textContent = sym.detail;
        row.appendChild(detail);
      }
      row.addEventListener("click", () => {
        if (deps.getOpenFile() === null) return;
        editor.revealPosition({ line: sym.line, character: sym.character });
        editor.focus();
      });
      root.appendChild(row);
      if (hasChildren && !collapsed) {
        for (const child of sym.children!) renderNode(child, depth + 1);
      }
    };
    for (const sym of outlineSymbols) renderNode(sym, 0);
    outlinePane.appendChild(root);
  }

  async function refreshOutline(): Promise<void> {
    const current = deps.getOpenFile();
    if (current === null || deps.getWorkspaceRoot() === "" || lspStatus.state !== "ready") {
      outlineSymbols = [];
      renderOutlineTree();
      return;
    }
    const token = ++outlineToken;
    const symbols = await api.lsp.documentSymbols(deps.relPathOf(current.path));
    if (outlineToken !== token || deps.getOpenFile() !== current) return;
    outlineSymbols = symbols;
    renderOutlineTree();
  }

  // 编辑防抖触发大纲刷新（与 didChange 同步节奏，避免输入时树闪烁）
  let outlineRefreshTimer: number | undefined;
  function scheduleOutlineRefresh(): void {
    window.clearTimeout(outlineRefreshTimer);
    outlineRefreshTimer = window.setTimeout(() => void refreshOutline(), 600);
  }

  renderOutlineTree(); // 启动即渲染空态占位（文件打开/LSP 就绪后填充）

  api.lsp.onStatus((status) => {
    const wasReady = lspStatus.state === "ready";
    lspStatus = status;
    renderLspStatus();
    // 服务器后于文件打开才就绪：补偿重放 didOpen（未就绪期间的 didOpen 被主进程丢弃）
    if (!wasReady && status.state === "ready") {
      syncOpenFileToLsp();
      void refreshOutline(); // 服务器就绪后立即取大纲
    }
  });
  api.lsp.onDiagnostics((items) => {
    lspDiags = items;
    renderLspStatus();
    applyEditorDiagnostics();
  });
  // 启动恢复（AC15 工作区恢复后主进程已启动 LSP）：主动拉一次当前态
  void api.lsp.getStatus().then((status) => {
    lspStatus = status;
    renderLspStatus();
  });
  void api.lsp.diagnostics().then((items) => {
    lspDiags = items;
    renderLspStatus();
    applyEditorDiagnostics();
  });

  return {
    renderLspStatus,
    applyEditorDiagnostics,
    syncOpenFileToLsp,
    scheduleLspSync,
    hideCompletion,
    scheduleCompletion,
    scheduleOutlineRefresh,
    refreshOutline,
    renderOutlineTree,
  };
}
