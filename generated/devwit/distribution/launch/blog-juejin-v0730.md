# 我造了一个 AI IDE：它把发给模型的每一个 token 都摆在你面前

用 AI 编程工具久了，总会撞上两堵墙。

**第一堵墙：上下文黑盒。** 模型回答质量下降，你不知道为什么——是悄悄塞进了一个 4 万 token 的文件？还是一条过期检索结果挤掉了你真正关心的代码？大多数工具把 prompt 当黑盒，你只能猜。

**第二堵墙：权限黑盒。** 能写文件、能跑命令的 Agent 确实好用——直到它做了一件你没预期的事。"它大部分时候会先问我"不算权限模型。

[DevWit](https://github.com/eeyzs1/DevWit) 是我对这两堵墙的回答：一个免费、开源的 AI IDE，把"模型看到了什么"和"Agent 要做什么"全部摆到台面上，并且可强制执行。

## 两个老特性，一句话带过

- **上下文面板**：每次 LLM 请求发出前渲染完整清单——系统提示、工具列表、每个注入项（文件 / RAG 检索块 / 终端输出 / 诊断）各自标注 token 数，任何一项可单独关掉，清单落盘可审计。
- **授权门**：Agent 物理上无法在未获批准时写文件或执行命令。展示完整操作内容，可批准、拒绝、按项目记住。

## v0.7.30 新增：终端面板与命令面板

### 终端面板

侧栏第五个页签，真实 shell 会话：

- **真实 PTY**（node-pty，带回退），不是假输出框
- **ANSI 流式彩色渲染**，方向键 / Ctrl+C / Tab 补全 / 中文输入法完整传递
- **进程树击杀**——关会话时 `npm run dev` 的子孙进程一起收掉，不留端口占用
- 一键重启会话；输出 5000 行环形上限，构建刷屏不吃内存

诚实说明：它是流式渲染不是屏幕缓冲，全屏 TUI 程序（vim / htop）不在支持面——命令输出与 REPL 交互是一等场景。

### 命令面板

`Ctrl+Shift+P` 命令、`Ctrl+P` 文件（VS Code 惯例）。模糊匹配 + 完整键盘闭环（↑↓ / Enter / Escape）。面板跳转、形态切换、设置、搜索、保存——日常高频操作从此不碰鼠标。

## 八轮对抗性审查：147 项全部修复

v0.5.0 到 v0.7.30 之间，整个代码库经历了**八轮对抗性代码审查**——每轮一个新审查者攻击一个区域（渲染层 / 编辑器内核 / agent 运行时 / LSP·DAP·workspace / 聊天 UI / MCP / 首启体验 / 终端）：

- **147 项发现，全部修复**，含 5 项 critical（渲染层可控的路径重定根——会让工作区防护形同虚设；停止调试误杀用户进程等）
- 每个修复尽可能带回归测试
- 有意思的案例都在 [CHANGELOG](https://github.com/eeyzs1/DevWit/blob/main/CHANGELOG.md)：成本导出的 CSV 公式注入、Linux 上大小写变体的路径逃逸、opt-out 告别信标发错端点

没人会为这个开发布会，但 AI IDE 要碰你的文件，这部分决定它配不配被信任。

## 工程上的诚实

v0.7.30 由 **975 个单元测试和 37 套端到端测试**验证（驱动真实打包产物，不是 mock）。支持 Windows（NSIS）、macOS（dmg/zip）、Linux（AppImage/deb），自动更新走 GitHub Releases。

安装方式：

- **winget**：`winget install eeyzs1.DevWit`（0.7.28 已上线，0.7.30 审核中）
- **Homebrew**：`brew install --cask eeyzs1/tap/devwit`（0.7.30）
- 或从 [GitHub Releases](https://github.com/eeyzs1/DevWit/releases/latest) 下载

它刻意**没有**的东西：账号、云同步、市场、任何付费墙。遥测默认关闭、可选开启、匿名且零内容采集。它是免费软件，以后也是。

## ⭐ 一个免费的请求

开源项目从 0 到 1 的 star 是最难的——它决定了项目能否被更多人看见、能否申请免费代码签名（去掉 Windows 的 SmartScreen 拦截）。如果你觉得这个方向对，**花一秒在 GitHub 上点个 Star**，是对这个项目最大的支持。

**链接**：[GitHub](https://github.com/eeyzs1/DevWit)（点 ⭐ Star）· [下载 v0.7.30](https://github.com/eeyzs1/DevWit/releases/latest)
