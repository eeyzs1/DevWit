/**
 * 对话会话管理页签（迭代 28 / AC37）：多会话列表 / 新建 / 切换 / 改名 / 删除。
 *
 * 数据源是主进程 sessions:list（trace 摘要 + 元数据 overlay）；
 * 切换/新建由宿主回调驱动（renderer 持有 ChatController 与持久化职责）——
 * 本组件只做列表呈现与意图上报，改名/删除经 api.sessions 直达主进程。
 */
import type { ChatSessionInfo, DevwitApi } from "@devwit/contracts";
import { onDidChangeLocale, t } from "@devwit/i18n";

/** 列表标题显示：截断超长标题（预览可能取自整条首用户消息）。 */
export function displaySessionTitle(title: string, max = 30): string {
  const collapsed = title.replace(/\s+/g, " ").trim();
  if (collapsed === "") return t("sessions.new");
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/** 末活动时间显示：当天 HH:MM，跨天 YYYY-MM-DD（本地时区）。 */
export function formatSessionLastAt(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) {
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export interface SessionListOptions {
  api: DevwitApi;
  /** 当前活跃会话 id（行高亮 + 「当前」徽标）。 */
  getActiveSessionId: () => string;
  /** 点击会话行：宿主执行切换（ChatController.switchSession + 轨迹回放 + 持久化）。 */
  onSwitch: (sessionId: string) => void;
  /** 「新会话」按钮：宿主开新会话。 */
  onNew: () => void;
  /** 删除完成后通知：宿主检查被删的是否活跃会话（是则开新会话兜底）。 */
  onDeleted?: (sessionId: string) => void;
}

export interface SessionListHandle {
  root: HTMLElement;
  /** 重新拉取会话列表并重渲染（切换页签 / 改名 / 删除 / 会话首条消息后）。 */
  refresh(): Promise<void>;
  /** 卸载：退订语言变更并移除 DOM。 */
  dispose(): void;
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

export function mountSessionList(container: HTMLElement, options: SessionListOptions): SessionListHandle {
  const root = el("div", "dw-sessions");
  const toolbar = el("div", "dw-sessions-toolbar");
  const newBtn = el("button", "dw-btn dw-btn-primary", t("sessions.new")) as HTMLButtonElement;
  newBtn.addEventListener("click", () => options.onNew());
  toolbar.appendChild(newBtn);
  const list = el("div", "dw-sessions-list");
  root.append(toolbar, list);
  container.appendChild(root);

  let items: ChatSessionInfo[] = [];
  /** 改名进行中的会话 id（同时只允许一行处于编辑态）。 */
  let editingId: string | null = null;
  /** 删除两段确认：首次点击进入待确认态（3s 超时复位），再次点击执行。 */
  let confirmingId: string | null = null;
  let confirmTimer: number | undefined;

  function resetConfirm(): void {
    confirmingId = null;
    window.clearTimeout(confirmTimer);
  }

  function startRename(row: HTMLElement, info: ChatSessionInfo): void {
    editingId = info.sessionId;
    row.textContent = "";
    const input = el("input", "dw-input dw-sessions-rename-input") as HTMLInputElement;
    input.value = info.title;
    input.title = t("sessions.rename.tooltip");
    row.appendChild(input);
    input.focus();
    input.select();
    let settled = false;
    const commit = (save: boolean): void => {
      if (settled) return;
      settled = true;
      editingId = null;
      const title = input.value.trim();
      if (save && title !== "" && title !== info.title) {
        void options.api.sessions.rename(info.sessionId, title).then(() => refresh());
      } else {
        render();
      }
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") commit(true);
      else if (event.key === "Escape") commit(false);
    });
    input.addEventListener("blur", () => commit(true));
  }

  function render(): void {
    list.textContent = "";
    const activeId = options.getActiveSessionId();
    if (items.length === 0) {
      list.appendChild(el("div", "dw-sessions-empty", t("sessions.empty")));
      return;
    }
    for (const info of items) {
      const row = el("div", "dw-sessions-row");
      row.dataset["sessionId"] = info.sessionId;
      if (info.sessionId === activeId) row.classList.add("dw-sessions-row-active");
      const main = el("div", "dw-sessions-main");
      const titleRow = el("div", "dw-sessions-title-row");
      titleRow.appendChild(el("span", "dw-sessions-title", displaySessionTitle(info.title)));
      if (info.sessionId === activeId) {
        titleRow.appendChild(el("span", "dw-sessions-badge", t("sessions.active")));
      }
      main.appendChild(titleRow);
      main.appendChild(
        el(
          "div",
          "dw-sessions-meta",
          t("sessions.meta", { time: formatSessionLastAt(info.lastAt), count: String(info.eventCount) })
        )
      );
      const actions = el("div", "dw-sessions-actions");
      const renameBtn = el("button", "dw-btn dw-sessions-action", "✎") as HTMLButtonElement;
      renameBtn.title = t("sessions.rename.tooltip");
      renameBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        if (editingId === null) startRename(row, info);
      });
      const deleteBtn = el(
        "button",
        `dw-btn dw-sessions-action${confirmingId === info.sessionId ? " dw-sessions-confirm" : ""}`,
        confirmingId === info.sessionId ? t("sessions.delete.confirm") : "🗑"
      ) as HTMLButtonElement;
      deleteBtn.title = t("sessions.delete.tooltip");
      deleteBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        if (confirmingId !== info.sessionId) {
          confirmingId = info.sessionId;
          window.clearTimeout(confirmTimer);
          confirmTimer = window.setTimeout(() => {
            resetConfirm();
            render();
          }, 3_000);
          render();
          return;
        }
        resetConfirm();
        const deletedId = info.sessionId;
        void options.api.sessions.delete(deletedId).then(() => {
          options.onDeleted?.(deletedId);
          return refresh();
        });
      });
      actions.append(renameBtn, deleteBtn);
      row.append(main, actions);
      row.addEventListener("click", () => {
        if (editingId !== null) return; // 编辑态点击不触发切换
        options.onSwitch(info.sessionId);
      });
      list.appendChild(row);
    }
  }

  async function refresh(): Promise<void> {
    editingId = null;
    resetConfirm();
    items = await options.api.sessions.list();
    render();
  }

  // 语言热生效（AC12）：工具栏按钮/徽标/空态/工具提示按新语言重绘（数据不重新拉取）
  const unsubscribeLocale = onDidChangeLocale(() => {
    newBtn.textContent = t("sessions.new");
    render();
  });

  return {
    root,
    refresh,
    dispose(): void {
      window.clearTimeout(confirmTimer);
      unsubscribeLocale();
      root.remove();
    },
  };
}
