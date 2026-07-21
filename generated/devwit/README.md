# DevWit — 简洁上下文 AI 原生桌面 IDE

[English](README_EN.md)

DevWit 是一款自研的 AI 原生桌面 IDE：融合 VSCode 的编辑器能力、Cursor 的对话式编程、Claude Code 的 Agent 任务执行与 pi agent 的简洁上下文设计，避免长上下文膨胀，提供高效、透明、可审计的 AI 开发体验。

## 核心特性

| 特性 | 说明 |
|------|------|
| 自研编辑器内核 | piece-table 文本缓冲 + Canvas 渲染 + tree-sitter 语法高亮，支持 IME 中文输入、多光标、撤销/重做 |
| 简洁上下文引擎 | 每次 LLM 请求的完整上下文组成（系统提示、工具列表、注入项及各项 token 占用）对用户逐项可见，可逐项开启/关闭，manifest 落盘可审计 |
| 对话式编程 | 对话请求代码修改，修改以 diff 形式在编辑器内呈现，支持逐块接受/拒绝 |
| Agent 模式 | 授权门机制：读写文件、执行终端命令均需用户批准；支持多步任务，执行轨迹（trace）完整可见 |
| 多模型接入 | Anthropic API 与 OpenAI 兼容 API 双协议，自定义 base URL 与 API key（safeStorage 加密存储），会话中可切换模型 |
| 模式自定义 | 创建/编辑/删除模式，每个模式独立定义系统提示、工具集、模型与上下文注入策略，修改热生效无需重启 |

## 技术栈

- Electron 37 + TypeScript 5.8（monorepo，npm workspaces）
- esbuild 打包，vitest 单测，Playwright + CDP 驱动 E2E
- electron-builder 产出 Windows NSIS 安装包与绿色版

## 仓库结构

```
apps/desktop        Electron 应用（main / preload / renderer / E2E）
packages/
  contracts         跨进程契约类型（IPC 白名单）
  editor-core       piece-table 文档内核（无 DOM 依赖）
  editor-render     Canvas 渲染视图 + IME 输入捕获
  syntax            tree-sitter 高亮引擎
  llm-providers     Anthropic / OpenAI 兼容客户端（SSE 流式）
  context-engine    简洁上下文引擎（manifest + token 计量 + 逐项策略）
  agent-runtime     Agent 循环、工具执行、授权门、轨迹
  chat-ui           对话/上下文/diff 面板（headless 控制器 + DOM 视图）
  modes             模式定义存储（热更新事件）
  settings          设置与凭证（safeStorage 加密）
  workspace         文件树、git 状态、工作区服务
  terminal          终端服务（pipe / node-pty 后端）
verification/       验收检查脚本（context 审计、反 mock、架构边界、密钥扫描等）
evidence/           AC1–AC7 验收证据（截图、manifest、trace、构建日志）
```

## 快速开始

```powershell
npm install
npm run rebuild-native   # 编译 node-pty 原生模块（Electron ABI）
npm run dev              # 构建并启动
```

> 启动前置：系统需支持 safeStorage 加密（Windows DPAPI / macOS Keychain / Linux Secret Service），否则应用拒绝以明文降级运行。

## 测试与验证

```powershell
npm test                 # 216 项单元测试（27 个测试文件）
npm run lint             # ESLint，0 违规
npm run test:e2e         # E2E 冒烟：启动→编辑保存→上下文开关→diff 审查→Agent 授权→切模型→模式热更新
```

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
