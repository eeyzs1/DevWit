/**
 * 授权门首次导览（增长 D2）：首次会话在上下文导览之后顺次弹出，
 * 用短提示说明「写文件 / 跑命令必须先批准、可按项目记住、裁决留痕可审计」——
 * PH 已验证的差异化卖点之二，白名单学习（AC29）已实现但新用户发现不了。
 *
 * 持久化：onboarding.state.authGateTourSeen === true 后不再弹出。
 * 与上下文导览独立标记；由调用方在上下文导览关闭后顺次调度（不叠遮罩）。
 */
import type { DevwitApi } from "@devwit/contracts";
import { t } from "@devwit/i18n";

export interface AuthGateTourDeps {
  api: DevwitApi;
  /** 可选：导览关闭后回到对话页签（CTA「去发第一条消息」）。 */
  showChatTab?: () => void;
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

type OnboardingState = { completed?: boolean; contextTourSeen?: boolean; authGateTourSeen?: boolean };

async function readState(api: DevwitApi): Promise<OnboardingState> {
  const raw = (await api.settings.get("onboarding.state")) as OnboardingState | null;
  return raw !== null && typeof raw === "object" ? raw : {};
}

async function mergeState(api: DevwitApi, patch: OnboardingState): Promise<void> {
  const prev = await readState(api);
  await api.settings.set("onboarding.state", { ...prev, ...patch });
}

/** 若尚未看过授权门导览则弹出；已看过则 no-op。 */
export async function maybeOpenAuthGateTour(deps: AuthGateTourDeps): Promise<void> {
  const state = await readState(deps.api);
  if (state.authGateTourSeen === true) return;

  const mask = el("div", "dw-modal-mask dw-tour-mask");
  const modal = el("div", "dw-modal dw-tour-modal");
  mask.appendChild(modal);

  modal.appendChild(el("h2", undefined, t("tour.auth.title")));
  modal.appendChild(el("p", "dw-modal-hint", t("tour.auth.body")));
  const list = el("ul", "dw-tour-list");
  for (const key of ["tour.auth.bullet1", "tour.auth.bullet2", "tour.auth.bullet3"] as const) {
    list.appendChild(el("li", undefined, t(key)));
  }
  modal.appendChild(list);

  const actions = el("div", "dw-modal-actions");
  const gotIt = el("button", "dw-btn dw-btn-primary", t("tour.auth.gotIt"));
  actions.appendChild(gotIt);
  modal.appendChild(actions);

  const dismiss = (): void => {
    mask.remove();
    void mergeState(deps.api, { authGateTourSeen: true });
    deps.showChatTab?.();
  };
  gotIt.addEventListener("click", dismiss);
  mask.addEventListener("click", (ev) => {
    if (ev.target === mask) dismiss();
  });

  document.body.appendChild(mask);
}
