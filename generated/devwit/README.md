# DevWit — 简洁上下文 AI 原生桌面 IDE

[English](README_EN.md)

[![版本](https://img.shields.io/github/v/release/eeyzs1/DevWit?label=%E7%89%88%E6%9C%AC)](https://github.com/eeyzs1/DevWit/releases)
[![累计下载](https://img.shields.io/github/downloads/eeyzs1/DevWit/total?label=%E4%B8%8B%E8%BD%BD%E9%87%8F)](https://github.com/eeyzs1/DevWit/releases)
[![Stars](https://img.shields.io/github/stars/eeyzs1/DevWit?style=social&label=Star)](https://github.com/eeyzs1/DevWit/stargazers)
[![协议: MIT](https://img.shields.io/badge/%E5%8D%8F%E8%AE%AE-MIT-green)](LICENSE)

> **⭐ 如果 DevWit 对你有帮助，点一下右上角的 Star** —— 0→1 的 star 对开源项目意义重大：它是我们申请免费代码签名（去掉 Windows SmartScreen 拦截）、被社区推荐、被更多人看见的唯一公信号。你的一个 Star 是免费的，但对项目是决定性的。谢谢！

DevWit 是一款自研的 AI 原生桌面 IDE：融合 VSCode 的编辑器能力、Cursor 的对话式编程、Claude Code 的 Agent 任务执行与 pi agent 的简洁上下文设计，避免长上下文膨胀，提供高效、透明、可审计的 AI 开发体验。

## 为什么选 DevWit

| 关切 | Cursor / Copilot | DevWit |
|------|------------------|--------|
| 上下文透明度 | 黑盒，看不到发什么 | **逐项可见**：系统提示、工具、注入项及每项 token 占用全展示，可逐项开关 |
| 操作授权 | Agent 直接执行 | **授权门**：文件写入 / 终端命令需一键批准，裁决留痕可审计 |
| 上下文成本 | 塞满即用，token 失控 | **简洁上下文**：每项 token 可见可关，请求体积主动控制 |
| 定位 | 插件或闭源 SaaS | **独立 IDE**，MIT 开源，零账号零云端，数据不出本机 |
| 合规/审计 | 无 | 上下文 manifest 落盘 + 授权轨迹完整可追溯 |

适合：有合规/审计需求的团队、上下文洁癖的高级开发者、想看清 AI 到底发了什么的你。

## 下载安装

**最新版本 v0.7.0 · 免费软件 · MIT 协议**（全部构建产物见 [Releases](https://github.com/eeyzs1/DevWit/releases)）

### Windows（x64）

直接下载：[DevWit.Setup.0.7.0.exe](https://github.com/eeyzs1/DevWit/releases/download/v0.7.0/DevWit.Setup.0.7.0.exe)（NSIS 安装包，可选安装目录，支持 `/S` 静默安装）。

> **SmartScreen /「Windows 已保护你的电脑」**：当前 Windows 构建尚未代码签名（免费开源，SignPath 需仓库有一定 Star 后才能申请）。若弹出蓝屏拦截：
> 1. 点 **更多信息**
> 2. 再点 **仍要运行**
> 3. 若被 Defender 隔离：打开「病毒和威胁防护」→「保护历史记录」→ 允许该文件后重新打开安装包
>
> 这不是病毒——安装包由公开 [GitHub Actions](https://github.com/eeyzs1/DevWit/actions) 构建，源码与产物均可核对。给仓库一个 Star 有助于我们申请免费签名，去掉这层摩擦。

winget（microsoft/winget-pkgs#407506、#422497、#425984 已先后合并，最新 v0.6.0 已上线；v0.7.0 更新待提交）：

```powershell
winget install eeyzs1.DevWit
```

### macOS（Apple Silicon）

Homebrew（推荐，已可用）：

```bash
brew install --cask eeyzs1/tap/devwit
xattr -dr com.apple.quarantine /Applications/DevWit.app   # 未签名分发，首次运行前去一次隔离
```

或直接下载：[DevWit-0.7.0-arm64.dmg](https://github.com/eeyzs1/DevWit/releases/download/v0.7.0/DevWit-0.7.0-arm64.dmg)（Intel Mac 暂无构建）。

### Linux（x64）

- AppImage（支持应用内自动更新）：[DevWit-0.7.0.AppImage](https://github.com/eeyzs1/DevWit/releases/download/v0.7.0/DevWit-0.7.0.AppImage)，下载后 `chmod +x` 直接运行
- Debian/Ubuntu：[devwit_0.7.0_amd64.deb](https://github.com/eeyzs1/DevWit/releases/download/v0.7.0/devwit_0.7.0_amd64.deb)，`sudo dpkg -i` 安装

### 自动更新

| 平台 | 更新方式 |
|------|----------|
| Windows | 应用内自动更新（electron-updater；设置 → 通用 中可手动检查） |
| macOS | 未签名包不走自动更新：`brew upgrade --cask eeyzs1/tap/devwit`，或手动下载 dmg 覆盖 |
| Linux AppImage | 应用内自动更新 |
| Linux deb | 手动下载新版 deb 覆盖安装 |

## 核心特性

| 特性 | 说明 |
|------|------|
| 自研编辑器内核 | piece-table 文本缓冲 + Canvas 渲染 + tree-sitter 语法高亮；IME 中文、多光标、括号匹配/自动配对、自动缩进、代码折叠、minimap、行移动/注释/复制 |
| 简洁上下文引擎 | 每次 LLM 请求的完整上下文组成（系统提示、工具列表、注入项及各项 token 占用）对用户逐项可见，可逐项开启/关闭，manifest 落盘可审计 |
| 对话式编程 | 对话请求代码修改，修改以 diff 形式在编辑器内呈现，支持逐块接受/拒绝 |
| Agent 模式 | 授权门机制：读写文件、执行终端命令均需用户批准；支持多步任务，执行轨迹（trace）完整可见 |
| 多 Agent 编排 | 「指挥台」模式自动拆解任务为并行子代理；计划、子任务进度、授权裁决在活动流逐项可见，Planner 异常自动回退单任务执行 |
| 透明 RAG | 代码库索引（分块 + embedding）就绪后，检索命中以相似度与 token 占用逐项展示、可逐项剔除；索引状态与手动重建在设置页可见 |
| 成本预算仪表盘 | 按日/周/月/累计设定成本阈值并开启自动告警；超限瞬间推送提醒；近 30 天成本趋势与会话级成本归因可视化，成本报告一键导出 CSV/JSON |
| 零成本模型接入 | 预设目录一键填充 Ollama 本地免 key、DeepSeek、OpenRouter 免费档；keyless 通道对话与 embedding 双路支持，即装即用 |
| 多模型接入 | Anthropic API 与 OpenAI 兼容 API 双协议，自定义 base URL 与 API key（safeStorage 加密存储），会话中可切换模型 |
| 模式自定义 | 创建/编辑/删除模式，每个模式独立定义系统提示、工具集、模型与上下文注入策略，修改热生效无需重启 |
| 社区模式生态 | 零账号分享：模式可导出/导入 JSON 文件；内置社区索引（eeyzs1/devwit-modes）一键导入，导入后可编辑、重绑模型 |
| MCP 服务器 | 设置页管理 MCP 服务器（增删改查 + 状态徽标 + 工具计数），MCP 工具经授权门并入 Agent 工具集 |
| 代码智能 (LSP) | 内置 TypeScript/JavaScript 语言服务器（typescript-language-server），实时诊断、悬停信息、跳转定义，零系统依赖 |
| Git 版本控制 | 文件树状态徽标、暂存/取消暂存/提交、内联 diff 查看、pull/push 远程同步、提交历史查看 |
| 断点调试 (DAP) | 内置 vscode-js-debug 调试适配器，断点设置（支持运行时动态增删）、单步调试、变量查看、表达式求值，零系统依赖 |
| 国际化 | 界面中英双语，语言切换热生效无需重启；主进程错误以 ASCII 错误码输出，渲染端按当前语言本地化 |
| 跨平台分发 | Windows NSIS / macOS dmg / Linux AppImage+deb，GitHub Actions 三平台构建，Windows 与 AppImage 支持应用内自动更新 |

## 界面一览

| 透明上下文 + RAG | 对话 diff 审查 |
|---|---|
| ![上下文面板](docs/screenshots/context-panel-rag.png) | ![diff 审查](docs/screenshots/chat-diff-review.png) |

| Agent 授权门 | 多 Agent 编排 |
|---|---|
| ![授权门](docs/screenshots/agent-authorization-gate.png) | ![多 Agent 编排](docs/screenshots/multi-agent-orchestration.png) |

| 统一设置页 | 社区模式一键导入 |
|---|---|
| ![设置页](docs/screenshots/settings-unified.png) | ![社区模式](docs/screenshots/community-modes.png) |

## 技术栈

- Electron 37 + TypeScript 5.8（monorepo，npm workspaces）
- esbuild 打包，vitest 单测，Playwright + CDP 驱动 E2E
- electron-builder 产出 Windows NSIS、macOS dmg、Linux AppImage/deb；electron-updater 应用内自动更新

## 仓库结构

```
apps/desktop        Electron 应用（main / preload / renderer / E2E）
packages/
  contracts         跨进程契约类型（IPC 白名单）
  editor-core       piece-table 文档内核（无 DOM 依赖）
  editor-render     Canvas 渲染视图 + IME 输入捕获
  syntax            tree-sitter 高亮引擎
  llm-providers     Anthropic / OpenAI 兼容客户端（SSE 流式）+ 预设目录 + keyless 通道
  context-engine    简洁上下文引擎（manifest + token 计量 + 逐项策略）
  agent-runtime     Agent 循环、工具执行、授权门、轨迹、多代理编排
  chat-ui           对话/上下文/diff 面板 + 任务中心 + 活动流（headless 控制器 + DOM 视图）
  modes             模式定义存储（热更新）+ 导出/导入 + 社区索引客户端
  rag               代码库索引（分块 / embedding / 检索命中注入）
  mcp               MCP 客户端与服务器管理
  i18n              界面国际化（中英双语，热切换）
  settings          设置与凭证（safeStorage 加密）
  workspace         文件树、git 状态、工作区服务
  terminal          终端服务（pipe / node-pty 后端）
verification/       验收检查脚本（context 审计、反 mock、架构边界、密钥扫描等）
evidence/           AC1–AC25 验收证据（截图、manifest、trace、构建日志）
distribution/       分发基建（winget 清单 / Homebrew cask / 社区模式种子）
docs/screenshots/   README 真实界面截图
```

## 扩展开发

想为 DevWit 增加能力（自定义模式、MCP 工具、社区模式发布、代码级扩展）？
见 [docs/EXTENDING.md](docs/EXTENDING.md)——四层级扩展模型 + 模式文件格式 + 全部扩展接口与装配点。

## 快速开始

```powershell
npm install
npm run rebuild-native   # 编译 node-pty 原生模块（Electron ABI）
npm run dev              # 构建并启动
```

> 启动前置：系统需支持 safeStorage 加密（Windows DPAPI / macOS Keychain / Linux Secret Service），否则应用拒绝以明文降级运行。

## 测试与验证

```powershell
npm test                 # 747 项单元测试（69 个测试文件）
npm run lint             # ESLint，0 违规
npm run test:e2e         # E2E 冒烟：启动→编辑保存→上下文开关→diff 审查→Agent 授权→切模型→模式热更新
```

另有 10 套迭代级 E2E（`npm run test:e2e2` … `test:e2e14`），覆盖授权门、崩溃恢复、自动更新、MCP、透明 RAG、多 Agent 编排、零成本模型、模式导出/导入与社区模式生态，证据落盘 `evidence/AC*`。

验证脚本（验收门禁）：

```powershell
python verification/self-check.py --project-root .
python verification/consistency-check.py --project-root .
python verification/check-context-audit.py --project-root .
```

## 打包发布

```powershell
npm run pack   # electron-builder --dir → release/win-unpacked
npm run dist   # NSIS 安装包 → release/DevWit Setup x.y.z.exe
```

推送 `v*` 标签触发 CD（GitHub Actions 自动构建并发布 Release）。

## 安全设计

- 凭证经 safeStorage 加密落盘，绝不明文存储
- 渲染进程 CSP 锁定，IPC 白名单最小暴露
- Agent 危险操作一律经授权门，授权裁决留痕于轨迹

## 支持

DevWit 是免费开源软件，不商业化、不收费、不追踪。如果它对你有帮助，欢迎 ⭐ Star 支持一下——这是项目继续迭代和通过代码签名（SignPath）审核的唯一公信号依据。问题与建议请提 [Issue](https://github.com/eeyzs1/DevWit/issues)。
