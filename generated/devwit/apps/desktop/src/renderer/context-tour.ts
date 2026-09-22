/**
 * 上下文面板首次导览（增长 G1）：强制切到「上下文」页签一次，
 * 用短提示说明逐项 token / 开关——PH 已验证的差异化卖点。
 *
 * 持久化：onboarding.state.contextTourSeen === true 后不再弹出。
 * 与首次运行向导独立；向导关闭后再触发（由调用方调度）。
 */
import type { DevwitApi } from "@devwit/contracts";
import { t } from "@devwit/i18n";

export interface ContextTourDeps {
  api: DevwitApi;
  /** 强制切到上下文页签（渲染侧 activateSideTab("context")）。 */
  showContextTab: () => void;
  /** 关闭导览后切回对话页签（CTA「去发第一条消息」）。 */
  showChatTab?: () => void;
  /** 高亮上下文页签按钮（可选 pulse）。 */
  highlightTab?: (on: boolean) => void;
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

type OnboardingState = { completed?: boolean; contextTourSeen?: boolean };

async function readState(api: DevwitApi): Promise<OnboardingState> {
  const raw = (await api.settings.get("onboarding.state")) as OnboardingState | null;
  return raw !== null && typeof raw === "object" ? raw : {};
}

async function mergeState(api: DevwitApi, patch: OnboardingState): Promise<void> {
  const prev = await readState(api);
  await api.settings.set("onboarding.state", { ...prev, ...patch });
}

/**
 * 若尚未看过导览则弹出；已看过则 no-op。
 * v0.7.27（审查 R8-1）：返回在 dismiss() 内 resolve 的 Promise——调用方
 * 据此串行后续导览（旧实现 appendChild 后即返回，index.ts 的 await 只等到
 * 「已显示」，授权门导览立即叠上来：用户先看到错的那个 + 双层遮罩异常变暗）。
 */
export async function maybeOpenContextTour(deps: ContextTourDeps): Promise<void> {
  const state = await readState(deps.api);
  if (state.contextTourSeen === true) return;

  deps.showContextTab();
  deps.highlightTab?.(true);

  const mask = el("div", "dw-modal-mask dw-tour-mask");
  const modal = el("div", "dw-modal dw-tour-modal");
  mask.appendChild(modal);

  modal.appendChild(el("h2", undefined, t("tour.context.title")));
  modal.appendChild(el("p", "dw-modal-hint", t("tour.context.body")));
  const list = el("ul", "dw-tour-list");
  for (const key of ["tour.context.bullet1", "tour.context.bullet2", "tour.context.bullet3"] as const) {
    list.appendChild(el("li", undefined, t(key)));
  }
  modal.appendChild(list);

  const actions = el("div", "dw-modal-actions");
  const gotIt = el("button", "dw-btn dw-btn-primary", t("tour.context.gotIt"));
  actions.appendChild(gotIt);
  modal.appendChild(actions);

  // v0.7.27（R8-1）：dismiss 时 resolve——调用方可 await 完整导览生命周期
  let dismissed!: () => void;
  const dismissedPromise = new Promise<void>((resolve) => {
    dismissed = resolve;
  });
  const dismiss = (): void => {
    deps.highlightTab?.(false);
    mask.remove();
    // v0.7.27（R8-5）：完成标记失败可见（否则每次启动重弹且无提示）
    mergeState(deps.api, { contextTourSeen: true }).catch(() => undefined);
    deps.showChatTab?.();
    dismissed();
  };
  gotIt.addEventListener("click", dismiss);
  mask.addEventListener("click", (ev) => {
    if (ev.target === mask) dismiss();
  });

  document.body.appendChild(mask);
  await dismissedPromise;
}
