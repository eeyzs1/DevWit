/**
 * Git 版本控制 UI 集群（迭代 32 / AC41 → v0.7.7 自 index.ts 抽取为模块）。
 *
 * 覆盖：状态栏 git 项、左栏 Git 面板（分支/冲突/暂存/提交/stash）、
 * 只读 git diff 视图、blame 覆盖层、分支管理下拉、文件树徽章联动。
 * git:changed 推送与工作区文件事件防抖（800ms）由本模块订阅；
 * 依赖经 GitPanelDeps 注入（宿主持有 editor/openFile/workspaceRoot 状态）。
 */
import type { DevwitApi, GitBlameLine, GitBranch, GitPanelStatus, GitStashEntry } from "@devwit/contracts";
import { computeDiff } from "@devwit/chat-ui";
import type { EditorView } from "@devwit/editor-render";
import { t } from "@devwit/i18n";
import { el } from "./dom.js";

export interface GitPanelDeps {
  api: DevwitApi;
  editor: EditorView;
  gitPane: HTMLElement;
  blameBtn: HTMLButtonElement;
  statusGit: HTMLElement;
  filesPane: HTMLElement;
  editorArea: HTMLElement;
  getWorkspaceRoot(): string;
  getOpenFile(): { path: string } | null;
  relPathOf(absPath: string): string;
  openFileByPath(path: string): Promise<void>;
  showStatus(message: string): void;
  toLocalError(raw: string): string;
}

export interface GitPanelHandle {
  refreshGit(): Promise<void>;
  closeBlame(): void;
  updateTreeBadges(): void;
  /** 语言热生效：状态栏/面板重建 + 关闭残留弹层 + 打开中的 diff 标题刷新。 */
  applyLocale(): void;
}

export function mountGitPanel(deps: GitPanelDeps): GitPanelHandle {
  const { api, editor, gitPane, blameBtn, statusGit, filesPane, editorArea } = deps;
  let gitStatus: GitPanelStatus | null = null;
  let gitDiffOverlay: HTMLElement | null = null;
  let gitDiffTitleSpan: HTMLElement | null = null;
  let gitDiffFile: string | null = null;
  let branchDropdown: HTMLElement | null = null;
  /** 分支下拉的外部点击关闭监听（关闭时解绑——🟡修复 v0.7.9：
   * 原实现仅在"由它自己关闭"路径解绑，Escape/锚点二次点击/applyGitStatus
   * 路径关闭后残留 no-op 监听器，每次开下拉累积一条 document capture 监听） */
  let branchOutsideClick: ((ev: MouseEvent) => void) | null = null;
  let blameOverlay: HTMLElement | null = null;
  let blameActive = false;

  /** 状态栏 git 项：branch 常驻（git 工作区），变更计数 >0 时追加。 */
  function renderGitStatus(): void {
    if (gitStatus === null || deps.getWorkspaceRoot() === "") {
      statusGit.textContent = "";
      return;
    }
    const count = gitStatus.staged.length + gitStatus.unstaged.length + gitStatus.untracked.length + gitStatus.conflicts.length;
    statusGit.textContent =
      count === 0 ? `⑂ ${gitStatus.branch}` : t("status.git", { branch: gitStatus.branch, count: String(count) });
  }

  /** 徽章字母：untracked 的 "?" 统一显示为 U（与 VS Code 同口径）。 */
  function gitBadgeLetter(status: string): string {
    return status === "?" ? "U" : status;
  }

  function renderGitGroup(
    parent: HTMLElement,
    title: string,
    items: Array<{ path: string; status: string }>,
    action: "stage" | "unstage"
  ): void {
    if (items.length === 0) return;
    const group = el("div", "dw-git-group");
    group.appendChild(el("div", "dw-git-group-title", `${title} (${items.length})`));
    for (const item of items) {
      const row = el("div", "dw-git-row");
      const badge = el("span", `dw-git-badge dw-git-badge-${gitBadgeLetter(item.status)}`, gitBadgeLetter(item.status));
      const name = el("span", "dw-git-path", item.path);
      name.title = item.path;
      const actionBtn = el("button", "dw-git-action", action === "stage" ? "+" : "−");
      actionBtn.title = t(action === "stage" ? "git.stage" : "git.unstage");
      actionBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        void (action === "stage" ? doGitOp(() => api.git.stage(item.path)) : doGitOp(() => api.git.unstage(item.path)));
      });
      row.append(badge, name, actionBtn);
      row.addEventListener("click", () => void openGitDiff(item.path));
      group.appendChild(row);
    }
    parent.appendChild(group);
  }

  /** stage/unstage 操作统一入口：失败本地化提示；成功由 git:changed 推送刷新面板。 */
  async function doGitOp(op: () => Promise<void>): Promise<void> {
    try {
      await op();
    } catch (error) {
      deps.showStatus(deps.toLocalError(error instanceof Error ? error.message : String(error)));
    }
  }

  function renderGitPanel(): void {
    gitPane.textContent = "";
    const head = el("div", "dw-git-head");
    const branchSpan = el(
      "span",
      "dw-git-branch",
      gitStatus !== null && deps.getWorkspaceRoot() !== "" ? `⑂ ${gitStatus.branch}` : ""
    );
    if (gitStatus !== null && deps.getWorkspaceRoot() !== "") {
      branchSpan.classList.add("dw-git-branch-clickable");
      branchSpan.title = t("git.branch.title");
      branchSpan.addEventListener("click", () => void toggleBranchDropdown(branchSpan));
    }
    head.append(branchSpan);
    const refreshBtn = el("button", "dw-btn dw-btn-small", t("git.refresh"));
    refreshBtn.addEventListener("click", () => void refreshGit());
    head.appendChild(refreshBtn);
    gitPane.appendChild(head);

    if (deps.getWorkspaceRoot() === "" || gitStatus === null) {
      gitPane.appendChild(el("div", "dw-sidebar-empty", t("git.notRepo")));
      return;
    }
    const body = el("div", "dw-git-body");
    gitPane.appendChild(body);
    const total = gitStatus.staged.length + gitStatus.unstaged.length + gitStatus.untracked.length + gitStatus.conflicts.length;
    if (total === 0) {
      body.appendChild(el("div", "dw-sidebar-empty", t("git.clean")));
    }
    // 冲突区域（v0.4.0）：合并冲突文件 + 解决按钮（ours/theirs/manual）
    if (gitStatus.conflicts.length > 0) {
      const group = el("div", "dw-git-group dw-git-conflicts");
      group.appendChild(el("div", "dw-git-group-title dw-git-conflicts-title", `${t("git.conflicts")} (${gitStatus.conflicts.length})`));
      for (const item of gitStatus.conflicts) {
        const row = el("div", "dw-git-row dw-git-conflict-row");
        const badge = el("span", "dw-git-badge dw-git-badge-conflict", "!");
        const name = el("span", "dw-git-path", item.path);
        name.title = item.path;
        const absPath = `${deps.getWorkspaceRoot().replace(/[/\\]+$/, "")}/${item.path}`;
        name.addEventListener("click", () => void deps.openFileByPath(absPath));
        const openBtn = el("button", "dw-git-action", "↗");
        openBtn.title = t("git.conflict.open");
        openBtn.addEventListener("click", (event) => {
          event.stopPropagation();
          void deps.openFileByPath(absPath);
        });
        const oursBtn = el("button", "dw-git-action dw-git-resolve", t("git.conflict.ours"));
        oursBtn.title = t("git.conflict.ours");
        oursBtn.addEventListener("click", (event) => {
          event.stopPropagation();
          void doGitOp(() => api.git.resolveConflict(item.path, "ours")).then(() => deps.showStatus(t("git.conflict.resolved")));
        });
        const theirsBtn = el("button", "dw-git-action dw-git-resolve", t("git.conflict.theirs"));
        theirsBtn.title = t("git.conflict.theirs");
        theirsBtn.addEventListener("click", (event) => {
          event.stopPropagation();
          void doGitOp(() => api.git.resolveConflict(item.path, "theirs")).then(() => deps.showStatus(t("git.conflict.resolved")));
        });
        const manualBtn = el("button", "dw-git-action dw-git-resolve", t("git.conflict.manual"));
        manualBtn.title = t("git.conflict.manual");
        manualBtn.addEventListener("click", (event) => {
          event.stopPropagation();
          void doGitOp(() => api.git.resolveConflict(item.path, "manual")).then(() => deps.showStatus(t("git.conflict.resolved")));
        });
        row.append(badge, name, openBtn, oursBtn, theirsBtn, manualBtn);
        group.appendChild(row);
      }
      body.appendChild(group);
    }
    renderGitGroup(body, t("git.staged"), gitStatus.staged, "unstage");
    renderGitGroup(body, t("git.changes"), gitStatus.unstaged, "stage");
    renderGitGroup(body, t("git.untracked"), gitStatus.untracked, "stage");

    const foot = el("div", "dw-git-foot");
    const commitInput = el("input", "dw-git-commit-input");
    commitInput.placeholder = t("git.commitPlaceholder");
    const commitBtn = el("button", "dw-btn dw-btn-small dw-btn-primary", t("git.commit"));
    commitBtn.disabled = gitStatus.staged.length === 0;
    const doCommit = async (): Promise<void> => {
      const message = commitInput.value.trim();
      if (message === "") return;
      commitBtn.disabled = true;
      try {
        await api.git.commit(message);
        commitInput.value = "";
        deps.showStatus(t("git.commitDone"));
      } catch (error) {
        deps.showStatus(deps.toLocalError(error instanceof Error ? error.message : String(error)));
        commitBtn.disabled = false;
      }
    };
    commitBtn.addEventListener("click", () => void doCommit());
    commitInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void doCommit();
    });
    foot.append(commitInput, commitBtn);
    gitPane.appendChild(foot);

    // Stash 区（v0.4.0）：暂存按钮 + 暂存列表
    const stashBox = el("div", "dw-git-stash");
    const stashHead = el("div", "dw-git-stash-head");
    stashHead.appendChild(el("span", "dw-git-stash-title", t("git.stash.title")));
    const stashPushBtn = el("button", "dw-btn dw-btn-small", t("git.stash.push"));
    stashPushBtn.disabled = total === 0;
    stashPushBtn.addEventListener("click", () => void doStashPush());
    stashHead.appendChild(stashPushBtn);
    stashBox.appendChild(stashHead);
    const stashList = el("div", "dw-git-stash-list");
    stashBox.appendChild(stashList);
    gitPane.appendChild(stashBox);
    void refreshStashList(stashList);
  }

  /** 暂存当前变更（v0.4.0）。 */
  async function doStashPush(): Promise<void> {
    try {
      await api.git.stashPush();
      deps.showStatus(t("git.stash.push"));
    } catch (error) {
      deps.showStatus(deps.toLocalError(error instanceof Error ? error.message : String(error)));
    }
  }

  /** 刷新暂存列表（v0.4.0）：操作后渲染端自查 git:changed 推送会重建面板，此函数填充列表内容。 */
  async function refreshStashList(container: HTMLElement): Promise<void> {
    let entries: GitStashEntry[];
    try {
      entries = await api.git.listStash();
    } catch {
      return;
    }
    container.textContent = "";
    if (entries.length === 0) {
      container.appendChild(el("div", "dw-sidebar-empty", t("git.stash.empty")));
      return;
    }
    for (const entry of entries) {
      const row = el("div", "dw-git-stash-row");
      const msg = el("span", "dw-git-stash-msg", entry.message);
      msg.title = entry.message;
      const popBtn = el("button", "dw-git-action", "↧");
      popBtn.title = t("git.stash.pop");
      popBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void doGitOp(() => api.git.stashPop(entry.index));
      });
      const applyBtn = el("button", "dw-git-action", "↦");
      applyBtn.title = t("git.stash.apply");
      applyBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void doGitOp(() => api.git.stashApply(entry.index));
      });
      const dropBtn = el("button", "dw-git-action", "✕");
      dropBtn.title = t("git.stash.drop");
      dropBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (window.confirm(t("git.stash.dropConfirm", { index: String(entry.index) }))) {
          void doGitOp(() => api.git.stashDrop(entry.index));
        }
      });
      row.append(msg, popBtn, applyBtn, dropBtn);
      container.appendChild(row);
    }
  }

  /** 只读 git diff 视图（HEAD ↔ 工作区）：复用 dw-diff 样式与 computeDiff 纯逻辑，无接受/拒绝语义。 */
  async function openGitDiff(relPath: string): Promise<void> {
    closeGitDiff();
    let texts: { original: string; modified: string };
    try {
      texts = await api.git.diff(relPath);
    } catch (error) {
      deps.showStatus(deps.toLocalError(error instanceof Error ? error.message : String(error)));
      return;
    }
    const computation = computeDiff(texts.original, texts.modified);
    gitDiffFile = relPath;
    gitDiffOverlay = el("div", "dw-diff-overlay");
    const box = el("div", "dw-diff");
    const header = el("div", "dw-diff-header");
    gitDiffTitleSpan = el("span", undefined, t("git.diffTitle", { file: relPath }));
    const closeBtn = el("button", "dw-btn dw-btn-small", t("git.diffClose"));
    closeBtn.addEventListener("click", closeGitDiff);
    header.append(gitDiffTitleSpan, closeBtn);
    const body = el("div", "dw-diff-body");
    for (const segment of computation.segments) {
      if (segment.kind === "context") {
        for (const text of segment.lines) {
          body.appendChild(el("div", "dw-diff-line dw-diff-context", `  ${text}`));
        }
      } else {
        for (const line of segment.hunk.lines) {
          body.appendChild(
            el(
              "div",
              line.kind === "add" ? "dw-diff-line dw-diff-add" : "dw-diff-line dw-diff-remove",
              `${line.kind === "add" ? "+" : "-"} ${line.text}`
            )
          );
        }
      }
    }
    box.append(header, body);
    gitDiffOverlay.appendChild(box);
    editorArea.appendChild(gitDiffOverlay);
  }
  function closeGitDiff(): void {
    gitDiffOverlay?.remove();
    gitDiffOverlay = null;
    gitDiffTitleSpan = null;
    gitDiffFile = null;
  }

  /** 关闭 blame 覆盖层（v0.4.0）。 */
  function closeBlame(): void {
    blameOverlay?.remove();
    blameOverlay = null;
    blameActive = false;
    blameBtn.classList.remove("dw-btn-active");
  }

  /**
   * 切换 blame 覆盖层（v0.4.0）：点击 Blame 按钮 → 加载逐行注解 → 覆盖层展示。
   * 需打开文件且工作区为 git 仓库；再点关闭。
   */
  async function toggleBlame(): Promise<void> {
    if (blameActive) {
      closeBlame();
      return;
    }
    const openFile = deps.getOpenFile();
    if (openFile === null || deps.getWorkspaceRoot() === "") {
      deps.showStatus(t("status.openFileFirst"));
      return;
    }
    const rel = deps.relPathOf(openFile.path);
    blameBtn.classList.add("dw-btn-active");
    blameActive = true;
    // 加载中占位
    const loading = el("div", "dw-blame-overlay");
    loading.appendChild(el("div", "dw-blame-loading", t("git.blame.loading")));
    editorArea.appendChild(loading);
    blameOverlay = loading;
    let lines: GitBlameLine[];
    try {
      lines = await api.git.blame(rel);
    } catch {
      closeBlame();
      return;
    }
    if (!blameActive) return; // 加载期间被关闭
    loading.textContent = "";
    if (lines.length === 0) {
      loading.appendChild(el("div", "dw-blame-loading", t("git.blame.empty")));
      return;
    }
    // 按行号排序构建注解列
    const byLine = new Map<number, GitBlameLine>();
    for (const bl of lines) byLine.set(bl.line, bl);
    const doc = editor.document;
    const totalLines = doc.lineCount;
    const col = el("div", "dw-blame-col");
    for (let i = 1; i <= totalLines; i += 1) {
      const bl = byLine.get(i);
      const row = el("div", "dw-blame-row");
      if (bl === undefined) {
        row.appendChild(el("span", "dw-blame-hash", "·······"));
        row.appendChild(el("span", "dw-blame-author", "—"));
        row.appendChild(el("span", "dw-blame-date", ""));
      } else {
        row.appendChild(el("span", "dw-blame-hash", bl.hash));
        row.appendChild(el("span", "dw-blame-author", bl.author));
        row.appendChild(el("span", "dw-blame-date", bl.date));
        row.title = `${bl.hash} ${bl.author} ${bl.date}\n${bl.summary}`;
      }
      col.appendChild(row);
    }
    loading.appendChild(col);
  }
  blameBtn.addEventListener("click", () => void toggleBlame());

  /** 关闭分支下拉弹层（v0.4.0 Git 分支管理）——统一解绑外部点击监听。 */
  function closeBranchDropdown(): void {
    branchDropdown?.remove();
    branchDropdown = null;
    if (branchOutsideClick !== null) {
      document.removeEventListener("mousedown", branchOutsideClick, true);
      branchOutsideClick = null;
    }
  }

  /**
   * 切换分支下拉弹层：点击分支名展开，再次点击或外部点击关闭。
   * 弹层包含分支列表（当前分支高亮）、新建分支输入、删除按钮。
   * 定位锚定到分支名 span 的屏幕坐标，使用 fixed 定位脱离侧栏滚动。
   */
  async function toggleBranchDropdown(anchor: HTMLElement): Promise<void> {
    if (branchDropdown !== null) {
      closeBranchDropdown();
      return;
    }
    let branches: GitBranch[];
    try {
      branches = await api.git.listBranches();
    } catch (error) {
      deps.showStatus(deps.toLocalError(error instanceof Error ? error.message : String(error)));
      return;
    }
    if (branchDropdown !== null) {
      closeBranchDropdown();
      return;
    }
    const popup = el("div", "dw-branch-dropdown");
    const rect = anchor.getBoundingClientRect();
    popup.style.left = `${rect.left}px`;
    popup.style.top = `${rect.bottom + 2}px`;

    const list = el("div", "dw-branch-list");
    if (branches.length === 0) {
      list.appendChild(el("div", "dw-branch-empty", t("git.branch.empty")));
    }
    for (const br of branches) {
      const row = el("div", "dw-branch-row");
      if (br.current) row.classList.add("dw-branch-row-current");
      const mark = el("span", "dw-branch-mark", br.current ? "●" : "");
      const name = el("span", "dw-branch-name", br.name);
      row.append(mark, name);
      if (!br.current) {
        const delBtn = el("button", "dw-branch-del", "✕");
        delBtn.title = t("git.branch.delete");
        delBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          void deleteBranch(br.name);
        });
        row.appendChild(delBtn);
        row.addEventListener("click", () => void checkoutBranch(br.name));
      } else {
        const cur = el("span", "dw-branch-current-tag", t("git.branch.current"));
        row.appendChild(cur);
      }
      list.appendChild(row);
    }
    popup.appendChild(list);

    // 新建分支输入区
    const createBox = el("div", "dw-branch-create");
    const input = el("input", "dw-branch-create-input");
    input.placeholder = t("git.branch.createPlaceholder");
    const createBtn = el("button", "dw-btn dw-btn-small dw-btn-primary", t("git.branch.create"));
    const doCreate = (): void => {
      const name = input.value.trim();
      if (name === "") return;
      void createBranch(name, true);
    };
    createBtn.addEventListener("click", doCreate);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") doCreate();
      if (ev.key === "Escape") closeBranchDropdown();
    });
    createBox.append(input, createBtn);
    popup.appendChild(createBox);

    document.body.appendChild(popup);
    branchDropdown = popup;
    input.focus();

    // 外部点击关闭（下一帧生效，避免吞掉当前点击事件；关闭路径统一经
    // closeBranchDropdown 解绑——含 Escape/锚点二次点击/applyGitStatus）
    window.setTimeout(() => {
      const onDown = (ev: MouseEvent): void => {
        if (branchDropdown === null) return;
        if (branchDropdown.contains(ev.target as Node)) return;
        if (anchor.contains(ev.target as Node)) return;
        closeBranchDropdown();
      };
      branchOutsideClick = onDown;
      document.addEventListener("mousedown", onDown, true);
    }, 0);
  }

  async function checkoutBranch(name: string): Promise<void> {
    closeBranchDropdown();
    try {
      await api.git.checkout(name);
    } catch (error) {
      deps.showStatus(deps.toLocalError(error instanceof Error ? error.message : String(error)));
    }
  }

  async function createBranch(name: string, doCheckout: boolean): Promise<void> {
    try {
      await api.git.createBranch(name, doCheckout);
      closeBranchDropdown();
    } catch (error) {
      deps.showStatus(deps.toLocalError(error instanceof Error ? error.message : String(error)));
    }
  }

  async function deleteBranch(name: string): Promise<void> {
    if (!window.confirm(t("git.branch.deleteConfirm", { name }))) return;
    try {
      await api.git.deleteBranch(name);
      // 刷新下拉弹层内的分支列表（不关闭，便于连续删除）
      if (branchDropdown !== null) {
        closeBranchDropdown();
        await reopenBranchDropdown();
      }
    } catch (error) {
      deps.showStatus(deps.toLocalError(error instanceof Error ? error.message : String(error)));
    }
  }

  /** 删除分支后重建弹层：复用 git 头部的分支 span 作为锚点。 */
  async function reopenBranchDropdown(): Promise<void> {
    const anchor = gitPane.querySelector<HTMLElement>(".dw-git-branch");
    if (anchor !== null) {
      await toggleBranchDropdown(anchor);
    }
  }

  function applyGitStatus(status: GitPanelStatus | null): void {
    gitStatus = status;
    renderGitStatus();
    renderGitPanel();
    updateTreeBadges();
    // 状态变化时分支 span 被重建，关闭可能残留的下拉弹层防错位
    closeBranchDropdown();
  }

  /** 文件树徽章（AC41）：工作区相对路径 → 状态字母；工作区文件覆盖暂存同名项。 */
  function updateTreeBadges(): void {
    const map = new Map<string, string>();
    if (gitStatus !== null && deps.getWorkspaceRoot() !== "") {
      for (const item of gitStatus.staged) map.set(item.path, gitBadgeLetter(item.status));
      for (const item of gitStatus.untracked) map.set(item.path, gitBadgeLetter(item.status));
      for (const item of gitStatus.unstaged) map.set(item.path, gitBadgeLetter(item.status));
      for (const item of gitStatus.conflicts) map.set(item.path, "!");
    }
    for (const node of filesPane.querySelectorAll<HTMLElement>(".dw-tree-node")) {
      const badge = node.querySelector<HTMLElement>(".dw-tree-badge");
      const path = node.dataset["path"];
      if (badge === null || path === undefined) continue;
      const letter = map.get(deps.relPathOf(path));
      if (letter === undefined) {
        badge.textContent = "";
        badge.className = "dw-tree-badge";
      } else {
        badge.textContent = letter;
        badge.className = `dw-tree-badge dw-git-badge-${letter}`;
      }
    }
  }
  async function refreshGit(): Promise<void> {
    if (deps.getWorkspaceRoot() === "") {
      applyGitStatus(null);
      return;
    }
    applyGitStatus(await api.git.getStatus());
  }
  api.git.onChanged(applyGitStatus);
  // 工作区文件事件防抖联动（编辑器保存/外部改动经 watcher 推送，800ms 合并突发写入）
  let gitRefreshTimer: number | undefined;
  api.workspace.onEvent(() => {
    window.clearTimeout(gitRefreshTimer);
    gitRefreshTimer = window.setTimeout(() => void refreshGit(), 800);
  });

  /** 语言热生效（AC12）：状态栏/面板重建 + 关闭残留弹层 + diff 标题刷新。 */
  function applyLocale(): void {
    renderGitStatus();
    closeBranchDropdown(); // 语言切换重建面板，关闭可能残留的下拉弹层防错位
    renderGitPanel();
    // 打开中的 git diff 标题随语言热生效
    if (gitDiffFile !== null && gitDiffTitleSpan !== null) {
      gitDiffTitleSpan.textContent = t("git.diffTitle", { file: gitDiffFile });
    }
  }

  return { refreshGit, closeBlame, updateTreeBadges, applyLocale };
}
