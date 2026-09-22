/**
 * 跨文件搜索面板（v0.4.0 → v0.7.6 自 index.ts 抽取为模块）。
 *
 * 编辑器顶部的搜索/替换面板：Ctrl+Shift+F 切换（宿主接键盘），
 * 输入防抖 300ms 经 workspace.search IPC 搜索（主进程 worker 隔离，v0.7.4），
 * 点击结果跳转；全部替换按搜索结果逐文件改写并回刷活动文件。
 * 依赖经 SearchPanelDeps 注入（宿主持有 editor/openFiles/workspaceRoot 状态）。
 */
import type { DevwitApi, SearchResults } from "@devwit/contracts";
import { localizeError, t } from "@devwit/i18n";
import { el } from "./dom.js";

export interface SearchPanelElements {
  panel: HTMLElement;
  input: HTMLInputElement;
  results: HTMLElement;
  count: HTMLElement;
  caseBtn: HTMLButtonElement;
  regexBtn: HTMLButtonElement;
  wordBtn: HTMLButtonElement;
  toggleReplaceBtn: HTMLButtonElement;
  replaceRow: HTMLElement;
  replaceInput: HTMLInputElement;
  replaceAllBtn: HTMLButtonElement;
  closeBtn: HTMLButtonElement;
}

export interface SearchPanelDeps {
  api: DevwitApi;
  elements: SearchPanelElements;
  /** 当前工作区根（空串 = 未打开工作区）。 */
  getWorkspaceRoot(): string;
  /** 打开文件并返回（跳转前置）。 */
  openFileByPath(path: string): Promise<void>;
  /** 定位编辑器光标（0-based）。 */
  revealPosition(position: { line: number; character: number }): void;
  /** 活动文件路径（替换后回刷判定）。 */
  getActiveFilePath(): string | null;
  /** 活动文件被外部改写后回刷编辑器文档。 */
  onActiveFileRewritten(path: string): Promise<void>;
  /** 状态条提示。 */
  showStatus(message: string): void;
}

export interface SearchPanelHandle {
  toggle(): void;
  runSearch(): Promise<void>;
  applyLocale(): void;
}

/** 渲染端正则编译（与 workspace/search.ts 同口径）：字面量转义 + 全词 \b + 大小写 flag。 */
function compileRegexLocal(query: string, isRegex: boolean, caseSensitive: boolean, wholeWord: boolean): RegExp {
  let source: string;
  if (isRegex) {
    source = query;
  } else {
    source = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  if (wholeWord) {
    source = `\\b${source}\\b`;
  }
  return new RegExp(source, caseSensitive ? "g" : "gi");
}

export function mountSearchPanel(deps: SearchPanelDeps): SearchPanelHandle {
  const { api, elements: els } = deps;
  let panelVisible = false;
  let replaceRowVisible = false;
  let caseSensitive = false;
  let isRegex = false;
  let wholeWord = false;
  let lastResults: SearchResults | null = null;

  function toggle(): void {
    panelVisible = !panelVisible;
    els.panel.style.display = panelVisible ? "" : "none";
    if (panelVisible) {
      els.input.focus();
    } else {
      els.results.textContent = "";
      els.count.textContent = "";
      lastResults = null;
    }
  }

  els.closeBtn.addEventListener("click", () => toggle());
  els.caseBtn.addEventListener("click", () => {
    caseSensitive = !caseSensitive;
    els.caseBtn.classList.toggle("dw-search-opt-active", caseSensitive);
    void runSearch();
  });
  els.regexBtn.addEventListener("click", () => {
    isRegex = !isRegex;
    els.regexBtn.classList.toggle("dw-search-opt-active", isRegex);
    void runSearch();
  });
  els.wordBtn.addEventListener("click", () => {
    wholeWord = !wholeWord;
    els.wordBtn.classList.toggle("dw-search-opt-active", wholeWord);
    void runSearch();
  });
  els.toggleReplaceBtn.addEventListener("click", () => {
    replaceRowVisible = !replaceRowVisible;
    els.replaceRow.style.display = replaceRowVisible ? "" : "none";
    els.toggleReplaceBtn.classList.toggle("dw-search-opt-active", replaceRowVisible);
  });

  let searchDebounce: ReturnType<typeof setTimeout> | null = null;
  els.input.addEventListener("input", () => {
    if (searchDebounce !== null) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => void runSearch(), 300);
  });
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (searchDebounce !== null) clearTimeout(searchDebounce);
      void runSearch();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      toggle();
    }
  });
  els.replaceAllBtn.addEventListener("click", () => void replaceAll());

  /** 搜索请求序号（v0.7.19 / 审查 P3）：主进程每次搜索新建 worker 并行执行，
   *  乱序完成是常态——无守卫时旧请求的超时/结果会覆盖新查询的渲染并污染
   *  lastResults（replaceAll 随后用「新输入 + 旧命中集」错误组合）。 */
  let searchRequestSeq = 0;

  async function runSearch(): Promise<void> {
    const query = els.input.value;
    const requestSeq = ++searchRequestSeq;
    if (query === "") {
      els.results.textContent = "";
      els.count.textContent = "";
      lastResults = null;
      return;
    }
    if (deps.getWorkspaceRoot() === "") {
      els.results.textContent = "";
      els.count.textContent = t("search.noWorkspace");
      lastResults = null;
      return;
    }
    try {
      const results = await api.workspace.search(deps.getWorkspaceRoot(), {
        query,
        isRegex,
        caseSensitive,
        wholeWord,
      });
      if (requestSeq !== searchRequestSeq) return; // 已有更新的查询：本次作废
      lastResults = results;
      renderResults(results);
    } catch (error) {
      if (requestSeq !== searchRequestSeq) return; // 旧请求的迟到失败不覆盖新结果
      const raw = error instanceof Error ? error.message : String(error);
      els.count.textContent = /regex|regular|DW_SEARCH/i.test(raw) ? t("err.searchRegex") : localizeError(raw);
      els.results.textContent = "";
      lastResults = null;
    }
  }

  function renderResults(results: SearchResults): void {
    els.results.textContent = "";
    els.count.textContent =
      results.files.length === 0
        ? t("search.empty")
        : t("search.results", { n: String(results.totalMatches), files: String(results.files.length) });
    if (results.truncated) {
      els.results.appendChild(el("div", "dw-search-truncated", t("search.truncated")));
    }
    for (const file of results.files) {
      const fileGroup = el("div", "dw-search-file");
      const fileHeader = el("div", "dw-search-file-header");
      fileHeader.appendChild(el("span", "dw-search-file-name", file.relativePath));
      fileHeader.appendChild(el("span", "dw-search-file-count", String(file.matches.length)));
      fileGroup.appendChild(fileHeader);
      for (const match of file.matches) {
        const matchEl = el("div", "dw-search-match");
        matchEl.appendChild(el("span", "dw-search-match-line", String(match.line)));
        const preview = el("span", "dw-search-match-preview");
        const before = match.preview.slice(0, match.column - 1);
        const matched = match.preview.slice(match.column - 1, match.endColumn - 1);
        const after = match.preview.slice(match.endColumn - 1);
        preview.textContent = before;
        preview.appendChild(el("strong", "dw-search-match-hit", matched));
        preview.appendChild(document.createTextNode(after));
        matchEl.appendChild(preview);
        matchEl.addEventListener("click", () =>
          void (async () => {
            await deps.openFileByPath(file.absolutePath);
            deps.revealPosition({ line: match.line - 1, character: match.column - 1 });
          })()
        );
        fileGroup.appendChild(matchEl);
      }
      els.results.appendChild(fileGroup);
    }
  }

  async function replaceAll(): Promise<void> {
    if (lastResults === null || lastResults.files.length === 0) return;
    const replacement = els.replaceInput.value;
    const query = els.input.value;
    if (query === "") return;
    let regex: RegExp;
    try {
      regex = compileRegexLocal(query, isRegex, caseSensitive, wholeWord);
    } catch {
      deps.showStatus(t("err.searchRegex"));
      return;
    }
    let totalReplaced = 0;
    let filesTouched = 0;
    for (const file of lastResults.files) {
      let content: string;
      try {
        content = await api.workspace.read(file.absolutePath);
      } catch {
        continue;
      }
      // v0.7.19 修复（审查 P4）：保留文件原行尾风格——旧实现 split(/\r?\n/)
      // 吞掉 \r 后 join("\n") 写回，CRLF 文件被整体改写为 LF（git 整文件标红）
      const eol = content.includes("\r\n") ? "\r\n" : "\n";
      const lines = content.split(/\r?\n/);
      const matchLines = new Set(file.matches.map((m) => m.line));
      let changed = false;
      for (let i = 0; i < lines.length; i++) {
        if (!matchLines.has(i + 1)) continue;
        regex.lastIndex = 0;
        const original = lines[i] ?? "";
        const replaced = original.replace(regex, replacement);
        if (replaced !== original) {
          lines[i] = replaced;
          changed = true;
        }
      }
      if (!changed) continue;
      try {
        await api.workspace.write(file.absolutePath, lines.join(eol));
        filesTouched++;
        totalReplaced += file.matches.length;
        // v0.7.19 修复（审查 P5）：逐文件刷新其已打开标签的缓冲——旧实现
        // 只在「开始时的活动文件」匹配时刷新一次，循环期间切换标签后该
        // 标签的内存 doc 过期，Ctrl+S 会把替换结果静默回滚。回调内部按
        // path 定位 openFiles 条目（活动文件热替换编辑器，非活动只更新缓存，
        // 未打开的文件自然 no-op）。
        await deps.onActiveFileRewritten(file.absolutePath);
      } catch {
        // 写入失败跳过该文件
      }
    }
    deps.showStatus(t("search.replaced", { n: String(totalReplaced), files: String(filesTouched) }));
    void runSearch();
  }

  function applyLocale(): void {
    els.input.placeholder = t("search.placeholder");
    els.replaceInput.placeholder = t("search.replacePlaceholder");
    els.caseBtn.title = t("search.caseSensitive");
    els.regexBtn.title = t("search.regex");
    els.wordBtn.title = t("search.wholeWord");
    els.toggleReplaceBtn.title = t("search.toggleReplace");
    els.closeBtn.title = t("search.close");
    els.replaceAllBtn.textContent = t("search.replaceAll");
    if (lastResults !== null) {
      renderResults(lastResults);
    }
  }

  return { toggle, runSearch, applyLocale };
}
