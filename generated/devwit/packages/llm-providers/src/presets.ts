import type { ProviderPreset } from "@devwit/contracts";

/**
 * 知名 OpenAI 兼容服务预设目录（迭代 13 / AC22）。
 *
 * AR002：LLM endpoint 知识只归属本包——渲染端经 IPC（providers:presets）拉取，
 * 不在渲染进程硬编码任何域名。收录原则：
 * - 免费或极低成本，降低首次上手门槛（软件免费分发的核心诉求）；
 * - 协议为 OpenAI 兼容（anthropic 类型无预设，官方端点仍需用户显式填写）；
 * - models 为稳定型号建议（可为空——本地服务型号由用户安装情况决定）。
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "ollama",
    label: "Ollama",
    type: "openai",
    baseUrl: "http://localhost:11434/v1", // qg-allow: AR002 预设目录的 endpoint 知识天然归属本包，外置配置反而破坏单一事实源
    // 本地模型由用户 ollama pull 决定，不给固定建议
    models: [],
    keyless: true,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    type: "openai",
    baseUrl: "https://api.deepseek.com/v1", // qg-allow: AR002 预设目录的 endpoint 知识天然归属本包，外置配置反而破坏单一事实源
    models: ["deepseek-chat", "deepseek-reasoner"],
    keyless: false,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    type: "openai",
    baseUrl: "https://openrouter.ai/api/v1", // qg-allow: AR002 预设目录的 endpoint 知识天然归属本包，外置配置反而破坏单一事实源
    // 免费档型号随平台运营变化，不固化；用户按平台页面标注 ":free" 填写
    models: [],
    keyless: false,
  },
];
