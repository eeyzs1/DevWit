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

/** 若尚未看过导览则弹出；已看过则 no-op。 */
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

  const dismiss = (): void => {
    deps.highlightTab?.(false);
    mask.remove();
    void mergeState(deps.api, { contextTourSeen: true });
  };
  gotIt.addEventListener("click", dismiss);
  mask.addEventListener("click", (ev) => {
    if (ev.target === mask) dismiss();
  });

  document.body.appendChild(mask);
}
