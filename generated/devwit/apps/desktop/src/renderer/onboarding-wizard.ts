/**
 * 首次运行向导（迭代 18 / AC27）：语言 → 模型（预设 + 连接探测）→ 完成。
 *
 * - 触发：渲染端 bootstrap 判定「onboarding.state.completed !== true 且无任何 provider」；
 *   老用户升级（已有 provider）由 bootstrap 静默标记完成，不弹向导。
 * - 语言步即设置页同一套「跟随系统 / zh-CN / en-US」：setLocale 热生效 + 持久化 ui.locale。
 * - 模型步只收预设目录（AR002：endpoint 知识单一归属 llm-providers，IPC 下发）；
 *   自定义接入走 设置 → 模型，向导保持最小路径。探测/保存语义与设置页一致：
 *   keyless 预设隐藏 API Key 行且不触碰凭证存储；keyed 预设必须填 Key。
 * - 任一步「跳过」或完成步关闭都会持久化 onboarding.state.completed=true，
 *   同 userData 重启不再弹出；设置 → 通用 可随时重跑。
 */
import type { DevwitApi, ProviderConfig, ProviderPreset } from "@devwit/contracts";
import {
  LOCALES,
  LOCALE_LABEL,
  localizeError,
  onDidChangeLocale,
  resolveSystemLocale,
  setLocale,
  t,
  type Locale,
} from "@devwit/i18n";
import { captureEvent } from "./posthog.js";

export interface OnboardingWizardDeps {
  api: DevwitApi;
  /** provider 保存成功后回调（renderer 侧 reload + chat 选择器热更新）。 */
  onProvidersChanged: () => void;
  /** 完成步「打开文件夹」：复用主界面 openWorkspace（含 E2E 注入目录钩子）。 */
  onOpenFolder: () => Promise<void>;
}

/** t() 的键类型（仅 string 文案；数组文案走 ta()）。 */
type StringMessageKey = Parameters<typeof t>[0];

/** 预设 id → 说明文案词典键（与设置页同源；模板串键无法过 MessageKey 类型检查）。 */
const PRESET_HINT_KEY: Record<string, StringMessageKey> = {
  ollama: "provider.preset.hint.ollama",
  deepseek: "provider.preset.hint.deepseek",
  openrouter: "provider.preset.hint.openrouter",
};

const STEP_KEYS = ["wizard.step.lang", "wizard.step.provider", "wizard.step.done"] as const;

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

export function openOnboardingWizard(deps: OnboardingWizardDeps): void {
  const { api } = deps;
  const mask = el("div", "dw-modal-mask");
  const modal = el("div", "dw-modal dw-wizard");
  mask.appendChild(modal);

  let step: 0 | 1 | 2 = 0;
  let presets: ProviderPreset[] = [];
  let activePreset: ProviderPreset | null = null;

  const markCompleted = (): void => {
    void api.settings.set("onboarding.state", { completed: true });
  };
  const close = (): void => {
    markCompleted();
    captureEvent("onboarding_completed", { completed_step: step });
    unsubscribe();
    mask.remove();
  };

  // ==========================================================================
  // 步 1：语言（与设置页同一持久化键 ui.locale，热生效）
  // ==========================================================================

  function renderLang(body: HTMLElement): void {
    body.appendChild(el("p", "dw-modal-hint", t("wizard.welcome.body")));
    const form = el("div", "dw-form");
    form.appendChild(el("label", undefined, t("settings.general.language")));
    const select = el("select", "dw-select") as HTMLSelectElement;
    const systemOption = document.createElement("option");
    systemOption.value = "system";
    systemOption.textContent = t("settings.general.language.system");
    select.appendChild(systemOption);
    for (const locale of LOCALES) {
      const option = document.createElement("option");
      option.value = locale;
      option.textContent = LOCALE_LABEL[locale];
      select.appendChild(option);
    }
    void api.settings.get("ui.locale").then((stored) => {
      select.value = stored === "zh-CN" || stored === "en-US" ? stored : "system";
    });
    select.addEventListener("change", () => {
      const choice = select.value;
      setLocale(choice === "system" ? resolveSystemLocale() : (choice as Locale));
      void api.settings.set("ui.locale", choice);
    });
    form.appendChild(select);
    body.appendChild(form);

    const actions = el("div", "dw-modal-actions");
    const skipBtn = el("button", "dw-btn", t("wizard.skip"));
    skipBtn.addEventListener("click", close);
    const nextBtn = el("button", "dw-btn dw-btn-primary", t("wizard.next"));
    nextBtn.addEventListener("click", () => {
      step = 1;
      render();
    });
    actions.append(skipBtn, nextBtn);
    body.appendChild(actions);
  }

  // ==========================================================================
  // 步 2：模型（预设 + 连接探测；保存语义同设置页，字段由预设派生保持最小输入）
  // ==========================================================================

  function renderProvider(body: HTMLElement): void {
    body.appendChild(el("p", "dw-modal-hint", t("wizard.provider.hint")));
    const form = el("div", "dw-form");
    const presetSelect = el("select", "dw-select") as HTMLSelectElement;
    const presetHint = el("div", "dw-modal-hint");
    const baseUrlInput = el("input", "dw-input") as HTMLInputElement;
    baseUrlInput.type = "text";
    const secretLabel = el("label", undefined, t("provider.apiKey"));
    const secretInput = el("input", "dw-input") as HTMLInputElement;
    secretInput.type = "password";
    const modelInput = el("input", "dw-input") as HTMLInputElement;
    modelInput.type = "text";
    const modelDatalist = document.createElement("datalist");
    modelDatalist.id = "dw-wizard-model-suggestions";
    modelInput.setAttribute("list", modelDatalist.id);
    const errorBox = el("div", "dw-form-error");
    const probeStatus = el("div", "dw-modal-hint");

    form.append(
      el("label", undefined, t("provider.preset")),
      presetSelect,
      presetHint,
      el("label", undefined, t("provider.baseUrl")),
      baseUrlInput,
      secretLabel,
      secretInput,
      el("label", undefined, t("provider.model")),
      modelInput,
      modelDatalist,
      errorBox,
      probeStatus
    );
    body.appendChild(form);

    function applyPreset(preset: ProviderPreset | null): void {
      activePreset = preset;
      modelDatalist.textContent = "";
      probeStatus.textContent = "";
      probeStatus.classList.remove("dw-form-error");
      if (preset === null) return;
      baseUrlInput.value = preset.baseUrl;
      for (const model of preset.models) {
        const option = document.createElement("option");
        option.value = model;
        modelDatalist.appendChild(option);
      }
      modelInput.placeholder = preset.models[0] ?? "";
      const hintKey = PRESET_HINT_KEY[preset.id];
      presetHint.textContent = hintKey !== undefined ? t(hintKey) : "";
      secretLabel.style.display = preset.keyless ? "none" : "";
      secretInput.style.display = preset.keyless ? "none" : "";
      secretInput.value = "";
    }
    presetSelect.addEventListener("change", () => {
      applyPreset(presets.find((preset) => preset.id === presetSelect.value) ?? null);
    });

    // 预设目录经 IPC 异步下发；到达前下拉为空。无「自定义」项——自定义接入走设置页。
    presetSelect.textContent = "";
    for (const preset of presets) {
      const option = document.createElement("option");
      option.value = preset.id;
      option.textContent = preset.label;
      presetSelect.appendChild(option);
    }
    if (presets.length > 0 && activePreset === null) {
      // 默认选中首个预设（Ollama 居首，零成本路径零选择成本）
      presetSelect.value = presets[0]?.id ?? "";
      applyPreset(presets[0] ?? null);
    } else if (activePreset !== null) {
      presetSelect.value = activePreset.id;
      applyPreset(activePreset);
    }

    const actions = el("div", "dw-modal-actions");
    const backBtn = el("button", "dw-btn", t("wizard.back"));
    const probeBtn = el("button", "dw-btn", t("provider.probe")) as HTMLButtonElement;
    const skipBtn = el("button", "dw-btn", t("wizard.skip"));
    const saveBtn = el("button", "dw-btn dw-btn-primary", t("wizard.provider.saveNext")) as HTMLButtonElement;
    actions.append(backBtn, probeBtn, skipBtn, saveBtn);
    body.appendChild(actions);

    backBtn.addEventListener("click", () => {
      step = 0;
      render();
    });
    skipBtn.addEventListener("click", close);

    /** 连接探测（迭代 17 同语义）：成功回填真实型号 + 自动填首个；失败本地化 + Ollama 引导。 */
    async function runProbe(): Promise<void> {
      const baseUrl = baseUrlInput.value.trim();
      probeStatus.textContent = "";
      probeStatus.classList.remove("dw-form-error");
      if (baseUrl === "") {
        probeStatus.classList.add("dw-form-error");
        probeStatus.textContent = t("err.probeInvalidUrl");
        return;
      }
      probeBtn.disabled = true;
      probeStatus.textContent = t("provider.probe.running");
      try {
        const result = await api.providers.probe({
          type: activePreset?.type ?? "openai",
          baseUrl,
          ...(activePreset?.keyless === true ? { keyless: true } : {}),
          ...(secretInput.value !== "" ? { apiKey: secretInput.value } : {}),
        });
        if (result.models.length > 0) {
          probeStatus.textContent = t("provider.probe.ok", { count: result.models.length });
          modelDatalist.textContent = "";
          for (const model of result.models) {
            const option = document.createElement("option");
            option.value = model;
            modelDatalist.appendChild(option);
          }
          if (modelInput.value.trim() === "") {
            modelInput.value = result.models[0] ?? "";
          }
          modelInput.placeholder = result.models[0] ?? "";
        } else {
          probeStatus.textContent = t("provider.probe.okNoModels");
        }
      } catch (error: unknown) {
        const raw = error instanceof Error ? error.message : String(error);
        probeStatus.classList.add("dw-form-error");
        probeStatus.textContent = localizeError(raw);
        if (activePreset?.id === "ollama" && raw.includes("DW_PROBE_UNREACHABLE")) {
          probeStatus.appendChild(el("div", undefined, t("provider.probe.ollamaHint")));
        }
      } finally {
        probeBtn.disabled = false;
      }
    }
    probeBtn.addEventListener("click", () => {
      void runProbe();
    });

    saveBtn.addEventListener("click", () => {
      void (async () => {
        errorBox.textContent = "";
        if (activePreset === null) {
          errorBox.textContent = t("provider.required");
          return;
        }
        const baseUrl = baseUrlInput.value.trim();
        const model = modelInput.value.trim();
        if (baseUrl === "" || model === "") {
          errorBox.textContent = t("provider.required");
          return;
        }
        const keyless = activePreset.keyless;
        const id = `p-${Date.now().toString(36)}`;
        const credentialRef = `cred-${id}`;
        if (!keyless) {
          if (secretInput.value === "") {
            errorBox.textContent = t("provider.needKey");
            return;
          }
          await api.credentials.set(credentialRef, activePreset.type, secretInput.value);
        }
        const config: ProviderConfig = {
          id,
          type: activePreset.type,
          label: activePreset.label,
          baseUrl,
          model,
          credentialRef,
          maxTokens: 4096,
          ...(keyless ? { keyless: true } : {}),
        };
        await api.providers.upsert(config);
        deps.onProvidersChanged();
        step = 2;
        render();
      })().catch((error: unknown) => {
        errorBox.textContent = error instanceof Error ? error.message : String(error);
      });
    });
  }

  // ==========================================================================
  // 步 3：完成（打开项目文件夹 / 先逛逛）
  // ==========================================================================

  function renderDone(body: HTMLElement): void {
    body.appendChild(el("p", "dw-modal-hint", t("wizard.done.body")));
    const actions = el("div", "dw-modal-actions");
    const startBtn = el("button", "dw-btn", t("wizard.done.start"));
    startBtn.addEventListener("click", close);
    const openBtn = el("button", "dw-btn dw-btn-primary", t("wizard.done.openFolder")) as HTMLButtonElement;
    openBtn.addEventListener("click", () => {
      openBtn.disabled = true;
      void deps
        .onOpenFolder()
        .catch(() => undefined) // 目录已被移动等异常不阻断向导关闭（主界面状态栏已提示）
        .then(() => close());
    });
    actions.append(startBtn, openBtn);
    body.appendChild(actions);
  }

  function render(): void {
    modal.textContent = "";
    modal.appendChild(el("h2", undefined, t("wizard.title")));
    const progress = el("div", "dw-wizard-progress");
    STEP_KEYS.forEach((key, index) => {
      progress.appendChild(
        el(
          "span",
          index === step ? "dw-wizard-step dw-wizard-step-active" : "dw-wizard-step",
          `${index + 1}. ${t(key)}`
        )
      );
    });
    modal.appendChild(progress);
    const body = el("div", "dw-wizard-body");
    modal.appendChild(body);
    if (step === 0) renderLang(body);
    else if (step === 1) renderProvider(body);
    else renderDone(body);
  }

  const unsubscribe = onDidChangeLocale(render);
  // 预设目录异步到达后：若正停在模型步则重渲染填充下拉
  void api.providers.presets().then((list) => {
    presets = list;
    if (step === 1) render();
  });
  render();
  document.body.appendChild(mask);
}
