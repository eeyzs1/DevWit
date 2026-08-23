# DevWit 开发移交文档 — 2026-08-06

> 本文档面向接手 DevWit 继续开发的 AI IDE。读完后应能构建、测试、理解架构并继续迭代。

## 1. 项目概览

**DevWit** — 简洁上下文 AI 原生桌面 IDE。核心差异：上下文完全透明（每项 token 可见可关）+ 授权门（Agent 操作需批准）+ 独立 IDE（非 VS Code 插件）。

- **GitHub**: https://github.com/eeyzs1/DevWit
- **协议**: MIT，免费软件，不商业化
- **版本**: v0.5.0（已发布 Latest）— 编辑器增强 9 项
- **测试基线**: 747 单测 / 69 测试文件（DAP 偶发超时属环境抖动，重跑全绿）
- **仓库根**: `generated/devwit/`（git 仓库根在 `DevWit/`）

## 2. 快速开始

### 环境要求
- Node.js 20+
- Electron 37.10.3（本机已装 dist，打包零下载）
- pyright 1.1.411（Python LSP 运行时依赖）
- Windows/macOS/Linux 均可开发

### 常用命令（cwd = `generated/devwit/`）

```bash
npm install              # 安装依赖（首次）
npx tsc -b               # TypeScript 全量类型检查
npm run build            # 全量构建（tsc + esbuild renderer/main/preload + copy html）
npm run dev              # 构建 + 启动 Electron
npm test                 # 747 单测（vitest）
npm run dist             # 打包（electron-builder，三平台）
npm run lint             # ESLint
npm run rebuild-native   # 重编 node-pty（终端原生依赖，可选）
```

### 构建产物
- `apps/desktop/dist/main/index.js` — 主进程（esbuild ESM bundle）
- `apps/desktop/dist/main/preload.cjs` — preload（esbuild CJS bundle）
- `apps/desktop/dist/renderer/index.js` — 渲染进程（esbuild IIFE bundle）
- `release/` — electron-builder 打包产物

## 3. 仓库结构

```
generated/devwit/
├── apps/desktop/
│   ├── src/
│   │   ├── main/              # 主进程（Electron main）
│   │   │   ├── index.ts       # 入口
│   │   │   ├── ipc.ts         # IPC handler 表
│   │   │   ├── preload.ts     # preload 白名单暴露
│   │   │   ├── ai-runtime.ts  # AI 子系统 + 上下文 manifest
│   │   │   ├── lsp-service.ts # LSP 服务门面（TS+Python 路由）
│   │   │   ├── debug-service.ts # DAP 调试服务
│   │   │   ├── git-service.ts # Git 集成
│   │   │   ├── telemetry.ts   # PostHog 遥测（opt-in）
│   │   │   ├── safe-storage-backend.ts # 凭证加密存储
│   │   │   ├── session-meta-store.ts   # 会话元数据
│   │   │   ├── usage-store.ts # 用量统计
│   │   │   ├── updater.ts     # electron-updater 自动更新
│   │   │   ├── external-editor.ts # 外部编辑器启动
│   │   │   └── diagnostics.ts # 诊断
│   │   └── renderer/          # 渲染进程
│   │       ├── index.ts       # 渲染主入口（含编辑器/对话/设置/上下文面板）
│   │       ├── index.html     # HTML 壳
│   │       ├── app.css        # 全部样式
│   │       ├── settings-dialog.ts    # 统一设置页
│   │       ├── editor-setup-dialog.ts # 编辑器设置引导
│   │       └── onboarding-wizard.ts  # 首次启动向导
│   └── tests/
│       ├── *.test.ts          # 单测（10 个文件）
│       └── e2e/               # E2E 验证脚本（30+ 个 .mjs）
├── packages/
│   ├── contracts/             # 跨包类型 + IPC 通道定义
│   ├── lsp/                   # LSP 客户端（ts-server + pyright）
│   ├── dap/                   # DAP 调试客户端（js-debug）
│   └── editor-render/         # 编辑器渲染（piece-table + Canvas + tree-sitter）
├── distribution/
│   ├── launch/                # 发布/推广/运维
│   │   ├── HANDOVER-20260730.md  # 分发/推广交接文档
│   │   ├── promotion/         # 推广物料（掘金/Reddit+HN/B站）
│   │   ├── reply-furkan.cjs   # PH 评论回复工具
│   │   ├── fetch-ph-comments.cjs # PH 评论抓取工具
│   │   └── evidence/          # PH 评论状态 + 截图
│   └── winget/manifests/      # winget manifest（0.1.1~0.4.0）
├── evidence/                  # AC1-AC42 验收证据（截图 + JSON）
├── constraints/               # 架构规则 + 成本预算（YAML）
├── context/                   # 知识索引
├── docs/screenshots/          # README 截图
├── electron-builder.yml       # 打包配置
├── eslint.config.mjs
├── launch-credentials.env     # PostHog 等凭据（gitignore）
├── AGENTS.md / CLAUDE.md      # ⚠️ meta-harness 框架指令，非 DevWit 开发指令，忽略
├── README.md / README_EN.md   # 中英文 README
└── package.json               # monorepo 根（workspaces: apps/* + packages/*）
```

## 4. 架构设计

### 进程模型（Electron 三层）

```
主进程 (main/index.ts)
  ├── IPC handler 表 (ipc.ts) — 渲染进程通过 window.api.* 调用
  ├── AI Runtime (ai-runtime.ts) — LLM 请求 + 上下文 manifest + 授权门
  ├── LSP Service (lsp-service.ts) — TS + Python 双 server 路由
  ├── DAP Service (debug-service.ts) — 断点/watch/attach
  ├── Git Service (git-service.ts) — 分支/stash/blame/merge
  ├── Telemetry (telemetry.ts) — PostHog opt-in
  └── Safe Storage (safe-storage-backend.ts) — 凭证加密
      │
      ├── preload (preload.cjs) — IPC 白名单最小暴露
      │
      └── 渲染进程 (renderer/index.ts)
           ├── 编辑器内核 — piece-table + Canvas 渲染 + tree-sitter 高亮
           ├── 对话面板 — 上下文清单（逐项可见可关）+ diff 审查
           ├── 设置页 — 通用/模型/编辑器/模式/MCP 五分区
           ├── 多 Agent 编排 — 指挥台模式
           └── 上下文面板 — RAG 命中 + token 占用 + 授权轨迹
```

### 编辑器内核（packages/editor-render/）
- **piece-table 文本缓冲** — 非 Monaco，自研
- **Canvas 渲染** — 避免 DOM 重绘开销
- **tree-sitter 语法高亮** — 多语言支持
- **功能**: 多光标、IME 中文输入、撤销/重做、括号匹配、代码折叠、minimap、自动缩进、行注释、行移动、行复制
- **纯函数**: `computeAutoIndent` / `outdentLine` / `computeFoldRegions` / `minimapLayout` — 有单测

### AI Runtime（ai-runtime.ts）
- 上下文 manifest — 每项（系统提示/工具/RAG/终端输出）的 token 占用可见可关
- 授权门 — 文件写入/终端命令需一键批准，裁决留痕
- manifest 可导出 JSON（审计）
- 模型路由 — 简单→本地，复杂→云端（可手动覆盖）

### LSP（packages/lsp/）
- `ts-server.ts` — TypeScript language server（typescipt-language-server）
- `pyright-server.ts` — Python language server（pyright）
- `lsp-client.ts` — LSP JSON-RPC 客户端
- 支持: completion / references / rename / codeAction / signatureHelp / documentSymbol

### DAP（packages/dap/）
- 基于 vendor/js-debug（dapDebugServer.js）
- 支持: 条件断点 / watch / log point / attach 到运行中进程

### i18n 机制
- 词典文件: `locales/zh-CN.ts` + `en-US.ts`（编译期同型校验）
- 渲染端: `t()` 函数，`t("common.id")` 风格
- 错误码: 主进程 stderr 输出 `DW_*` 前缀 ASCII 码，渲染端 `localizeError()` 映射
- 语言切换热生效，持久化到 `settings["ui.locale"]`

### 配置系统
- 设置页五分区: 通用 / 模型 / 编辑器 / 模式 / MCP
- 所有配置支持热更新（不重启）
- 凭证经 safeStorage 加密落盘

## 5. 开发约束与规范（硬约束）

1. **i18n 强制** — 全部 UI 文案通过 `t()` 函数，禁止硬编码中文字符串
2. **ASCII 错误码** — 主进程 stderr 用 `DW_*` 前缀，禁止直接输出中文
3. **免费软件定位** — 不引入账号/付费/云端同步/模式市场
4. **遥测 opt-in** — 默认关闭，匿名，零内容收集（仅事件名/计数/版本/OS/installId）
5. **热更新配置** — 所有配置（含凭证）支持热更新，不重启
6. **应用退出** — 停止全部 MCP 子进程，防孤儿进程
7. **编辑器未设置** — 点击打开编辑器但未设置时，显示引导小页面
8. **瞬态提示** — 用 statusMessage 而非 activeFileLabel，避免覆盖活动文件标签
9. **遥测去重** — 禁止同时用渲染进程 SDK 和主进程 batch API

## 6. 当前版本状态

### v0.4.0（已发布 Latest）
- P1 LSP 代码智能（6 项全完成）: completion / references / codeAction / rename / signatureHelp / documentSymbol
- P1 Git 集成（4 项）: 分支管理 / stash / blame / merge conflict
- P1 DAP 调试（4 项）: 条件断点 / watch / log point / attach
- P1 编辑器增强（3 项）: 跨文件搜索 / 文件大纲 / 拖拽标签页
- P2 AI 增强: 上下文 manifest 导出 / RAG 增量索引 / Python LSP

### v0.5.0（已发布 Latest — 2026-08-11）
| 功能 | 提交 |
|------|------|
| 括号对匹配高亮 + 缩进指南线 | `126056c` |
| 自动配对括号 | `2d5bd20` |
| 自动缩进（Enter 继承 + { 加级） | `0d9f707` |
| 选区缩进/反缩进（Tab/Shift+Tab） | `779f590` |
| Alt+Up/Down 行移动 | `843d94d` |
| Ctrl+/ 行注释切换 | `84042ba` |
| 代码折叠（缩进折叠 + 行号槽标记） | `69f1d62` |
| 行复制 + Ctrl+Backspace/Delete 删词 | `9a98844` |
| Minimap 缩略图 | `7b11d2f` |

### 真实用户指标（接手时 2026-08-11）
- GitHub stars/forks/watchers: **0/0/0**（推广待账号发布）
- 北极星目标 10 万用户；阻塞在分发与曝光，非产品功能
- Homebrew tap 已跟 Latest；winget 首包 #407506 已于 2026-08-21 合并（0.2.0 上线）；0.5.0 update PR #422497 已提交待审批

## 7. 待办事项（按优先级）

### P0 信任基建（分发阻塞，最高优先级）
| 项目 | 状态 | 下一步 |
|------|------|--------|
| **推广三连发** | 物料就绪 | 用户发 Show HN + 掘金 + dev.to |
| **winget PR #407506** | ✅ 已合并（2026-08-21，0.2.0 上线） | 0.5.0 update PR [#422497](https://github.com/microsoft/winget-pkgs/pull/422497) 待审批 |
| **SignPath 代码签名** | 被拒（0 star） | 攒 star 后重新申请 |

### P1 下一迭代候选
- [x] 上下文面板首次导览（加深 PH 已验证卖点）— `apps/desktop/src/renderer/context-tour.ts`
- [ ] Rust LSP（需评估二进制体积）
- [x] PostHog 事件 install/activate/session_start — opt-in 门控保留
- [x] 对话完成时用量/成本更醒目（G2）— 对话/活动流用量行 + 状态栏回显

### 推广物料位置
- 掘金: `distribution/launch/promotion/juejin.md`
- Reddit + HN: `distribution/launch/promotion/reddit-hn.md`
- B站: `distribution/launch/promotion/bilibili.md`
- 增长简报: `distribution/launch/GROWTH-OPS-20260811.md`
- 反馈 backlog: `distribution/launch/GROWTH-FEEDBACK-BACKLOG.md`

## 8. 外部分发状态

### winget
- 首包 PR #407506（0.2.0）：✅ 已于 2026-08-21 合并上线 → `winget install eeyzs1.DevWit`
- 0.5.0 update PR #422497：已提交待审批（winget-pkgs 校验管线运行中）
- manifest 源在 `distribution/winget/manifests/e/eeyzs1/DevWit/0.5.0/`（InstallerUrl 已修正、SHA256 已实证）

### Product Hunt
- 7/30 首发，2 个真实用户正面反馈（Furkan、Ferdi，均夸 token 成本透明度）
- 评论已全部回复
- PH 评论监控计划任务已停用（Chrome 150 CDP 限制），改手动巡检
- 回复工具: `distribution/launch/reply-furkan.cjs`（修改 FURKAN_MARKER + REPLY_TEXT 后复用）

### 构建配置（electron-builder.yml）
- Windows: NSIS（未签名，SmartScreen 拦截）
- macOS: dmg + zip（未签名，`xattr -dr com.apple.quarantine` 绕过）
- Linux: AppImage + deb
- publish: GitHub Releases（electron-updater 自动更新）
- asarUnpack: typescript-language-server / typescript / pyright / js-debug

## 9. 已知问题与技术债

### Chrome 150 CDP 限制（影响 PH 自动化）
- `--remote-debugging-port` 不允许默认 user-data-dir
- 解决方案: 复制 profile 到临时目录 + 原生启动 Chrome + connectOverCDP
- 详见 `distribution/launch/HANDOVER-20260730.md` 的 "PH 回复技术方案" 段

### 未签名
- SmartScreen 拦截 Windows 下载（v0.4.0 发布 3 天 0 下载）
- macOS 需手动 `xattr -dr`
- 解决依赖 SignPath（需先攒 star）

### PH 评论监控
- 原计划任务因 Chrome 未带 CDP 启动而持续失败
- 已停用，改手动巡检 + reply-furkan.cjs 工具

### koa-connect wrapper
- 早期 ctx 泄漏问题，已用原生重写（历史教训，非当前问题）

### js-debug resume 竞态
- 无断点场景程序悬挂在第 1 行
- 修复: 客户端兜底首个 reason=pause 的 stopped 事件自动 continue

### tsserver 诊断延迟
- 重推诊断存在几百毫秒延迟，断言用轮询机制避免竞态

## 10. 接手指南

### 忽略 meta-harness 框架
`AGENTS.md` / `CLAUDE.md` / `.cursorrules` / `constraints/` / `context/` / `evolution/` 是 meta-harness 生成框架的历史产物，**不是 DevWit 产品开发指令**。实际开发聚焦 `apps/desktop/src/` + `packages/` 源码。

### 先读这些文件
1. `packages/contracts/src/index.ts` — 全部跨包类型与 IPC 通道定义（理解通信契约）
2. `apps/desktop/src/main/ipc.ts` — IPC handler 表（理解主进程能力）
3. `apps/desktop/src/main/preload.ts` — preload 白名单（理解渲染进程可调用的 API）
4. `apps/desktop/src/main/ai-runtime.ts` — AI 子系统（理解核心差异：上下文透明 + 授权门）
5. `apps/desktop/src/renderer/index.ts` — 渲染主入口（理解 UI 结构）

### 构建验证流程
```bash
npx tsc -b           # 类型检查必须通过
npm test             # 747 单测必须全绿
npm run build        # 构建必须成功
npm run dev          # 启动验证核心功能
```

### 提交规范
- 格式: `type(scope): 中文描述`
- type: feat / fix / docs / chore / refactor
- scope: editor / ci / readme / launch / handover 等
- 示例: `feat(editor): minimap 缩略图 — 右侧渲染 + 视口指示框 (v0.5.0)`

### 提交前检查
- `npx tsc -b` 通过
- `npm test` 全绿
- `git status` 确认无遗漏文件
- 不提交 `launch-credentials.env`（含凭据，gitignore）
- 不提交 `evidence/` 下的调试失败截图

### 外部账号（用户本人操作，AI 不可代劳）
- GitHub: eeyzs1（gh CLI 已配 SSH）
- Product Hunt: 已登录（临时 Chrome profile，cookie 可能不持久）
- winget: PR 通过 gh CLI 操作
- SignPath: 需攒 star 后重新申请
- 掘金/B站: 需用户登录发布

---

**最后更新**: 2026-08-22
**最新提交**: `0b02a8a` fix: 指挥台任务模型兜底 + 根治 E2E 进程树清理 EPERM
**测试基线**: 766 单测 / 71 测试文件（CI 双 job 稳定全绿，含 E2E Smoke）
**Latest**: https://github.com/eeyzs1/DevWit/releases/tag/v0.6.0

