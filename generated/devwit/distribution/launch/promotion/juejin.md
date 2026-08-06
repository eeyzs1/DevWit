# Cursor 的上下文是黑盒——我造了个透明的 AI IDE，开源了

用 Cursor / Copilot 的时候，你有没有过这种不安：

它给大模型到底发了什么？整个文件？哪几个文件？系统提示里塞了什么？工具列表多长？这些加起来多少 token？为什么这次回答又贵又慢，上次却很快？

你看不到。它是个黑盒。

Agent 模式更慌——它说要"重构这个模块"，然后开始改文件、跑命令。你只能事后看结果。如果它改错了文件、删错了东西，你来不及拦。

我受够了这种黑盒，所以造了 **DevWit**：一个上下文完全透明、每个操作都要你批准的 AI 原生桌面 IDE。MIT 开源，免费，不收费，不追踪。

GitHub：https://github.com/eeyzs1/DevWit

## 核心差异：上下文面板

这是 DevWit 和其他 AI 编程工具最本质的区别。每次发起 LLM 请求，你都能看到一个完整的上下文清单：

- 系统提示（完整内容，不是摘要）
- 注入的工具列表（每个工具的 schema）
- 注入的代码片段 / RAG 检索块 / 终端输出（每一项单独列出）
- **每一项的 token 占用**

更重要的是：**每一项都可以单独开关**。觉得某个 RAG 块没用？关掉，请求立刻缩小。觉得工具列表太长占 token？关掉用不到的。请求体积是你主动控制的，不是黑盒塞满。

![上下文面板](https://raw.githubusercontent.com/eeyzs1/DevWit/main/generated/devwit/docs/screenshots/context-panel-rag.png)

这不是"显示一下给你看看"——它是真的可操作的。关掉一项，下一次请求的 token 数实打实减少。上下文 manifest 还能导出 JSON 落盘，审计可追溯。

## 授权门：Agent 不能偷偷动手

DevWit 的 Agent 模式有个硬规则：**写文件、执行终端命令，必须经你一键批准**。

它要改 `src/foo.ts`？弹授权。它要跑 `npm install`？弹授权。你可以逐次批准，也可以按项目记住授权。每个授权裁决都留在执行轨迹里，事后能查。

![授权门](https://raw.githubusercontent.com/eeyzs1/DevWit/main/generated/devwit/docs/screenshots/agent-authorization-gate.png)

这不是给小白用的护栏——这是给**需要对 AI 行为负责的人**用的。如果你的团队有合规要求、代码审计要求，或者你单纯想知道 AI 到底干了什么，这个授权门 + 上下文 manifest 的组合就是审计材料。

## 不只是个 AI 壳，它是个真 IDE

很多 AI 编辑器是"VS Code 插件 + 对话框"。DevWit 是独立 IDE，自研编辑器内核：

- **piece-table 文本缓冲 + Canvas 渲染 + tree-sitter 语法高亮**——不是套 Monaco，是从内核写的
- 支持多光标、IME 中文输入、撤销/重做、括号匹配、代码折叠、minimap 缩略图
- **LSP 代码智能**：TypeScript/JavaScript + Python（pyright），补全/引用/重命名/签名帮助/文档大纲
- **Git 集成**：分支管理、stash、blame、merge conflict 引导
- **DAP 调试**：条件断点、watch 表达式、log point、attach 到运行中进程
- **多 Agent 编排**：「指挥台」模式自动拆任务为并行子代理，计划和授权在活动流逐项可见
- **MCP 服务器**：设置页管理，MCP 工具经授权门并入 Agent 工具集
- **透明 RAG**：代码库索引后，检索命中逐项展示相似度和 token 占用，可逐项剔除

![多 Agent 编排](https://raw.githubusercontent.com/eeyzs1/DevWit/main/generated/devwit/docs/screenshots/multi-agent-orchestration.png)

对话改代码以 diff 形式呈现，逐块接受/拒绝：

![diff 审查](https://raw.githubusercontent.com/eeyzs1/DevWit/main/generated/devwit/docs/screenshots/chat-diff-review.png)

## 零成本模型接入

预设目录一键填充：
- **Ollama 本地免 key**——对话和 embedding 双路支持，完全离线可用
- **DeepSeek / OpenRouter 免费档**——keyless 通道，装上就能用
- 自定义 Anthropic API / OpenAI 兼容 API，base URL 和 key 可配（safeStorage 加密存储）

会话中可随时切模型。keyless 通道意味着你不用先去注册付费 API 就能体验完整功能。

## 为什么开源、为什么免费

因为 AI 编程工具的上下文透明度不应该是付费墙后面的功能。"看清 AI 发了什么"是基本权利，不是高级订阅。

DevWit 是 MIT 协议，没有账号系统、没有云同步、没有付费墙、没有遥测默认开启（遥测 opt-in 默认关闭，匿名，零内容收集）。数据不出你的机器。

747 个单元测试，69 个测试文件，全绿。三平台构建（Windows NSIS / macOS dmg / Linux AppImage+deb）由 GitHub Actions 公开产出。

## 下载

- **Windows**：[DevWit.Setup.0.4.0.exe](https://github.com/eeyzs1/DevWit/releases/download/v0.4.0/DevWit.Setup.0.4.0.exe)
- **macOS（Apple Silicon）**：[DevWit-0.4.0-arm64.dmg](https://github.com/eeyzs1/DevWit/releases/download/v0.4.0/DevWit-0.4.0-arm64.dmg)（未签名，首次运行 `xattr -dr com.apple.quarantine /Applications/DevWit.app`）
- **Linux**：[DevWit-0.4.0.AppImage](https://github.com/eeyzs1/DevWit/releases/download/v0.4.0/DevWit-0.4.0.AppImage) / [devwit_0.4.0_amd64.deb](https://github.com/eeyzs1/DevWit/releases/download/v0.4.0/devwit_0.4.0_amd64.deb)

全部构建产物见 Releases 页：https://github.com/eeyzs1/DevWit/releases

## 最后

如果你也是"上下文洁癖"——想知道 AI 每次到底发了什么、想控制每次请求的成本、想在 AI 动手前拦一下——欢迎试试。

如果对你有帮助，GitHub 给个 ⭐ Star 是最大的支持。项目目前 0 star，star 数是申请免费代码签名（SignPath）的公信号依据，签名后 Windows 用户就不会被 SmartScreen 拦截了。

https://github.com/eeyzs1/DevWit

问题、建议、bug 欢迎提 Issue。
