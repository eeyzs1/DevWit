# Product Hunt 首发素材包（DevWit v0.3.0）

> 全部文案可直接粘贴。数字均可追溯：仓库 eeyzs1/DevWit，Release v0.3.0（12 资产），
> 测试规模 614 单测 / 28 e2e 套件（见 memory/session-state.yaml 迭代 33）。

## 基本信息

- **Name**: DevWit
- **Tagline**（60 字符内，主选）:
  `The AI IDE that shows you exactly what it sends`
- Tagline 备选:
  - `Auditable AI coding — every token accounted for`
  - `Free, open-source AI IDE with a permission gate`
- **Website**: https://github.com/eeyzs1/DevWit
- **Topics**（最多 5 个）: Developer Tools, Artificial Intelligence, Open Source, Productivity, GitHub
- **Pricing**: Free
- **Launch 时间建议**: 周二至周四 00:01 PT（完整 24h 曝光窗口）

## Description（260 字符内，主选）

```
DevWit is a free, open-source AI IDE built on one principle: you should see
exactly what the AI sees and does. Every LLM request shows its full context —
system prompt, tools, injected code — with per-item token costs you can toggle.
Every file write and shell command needs your explicit approval.
```

（244 字符）

Description 备选（更短）:

```
Free, open-source AI IDE. Full context transparency: see every token sent to
the model, toggle any item off. Authorization gate on every file/shell action.
Windows, macOS, Linux.
```

（176 字符）

## First Comment（Maker 评论，发布后立刻自评）

```
Hi Product Hunt! I'm the maker of DevWit.

I built it because I kept hitting the same wall with AI coding tools: I couldn't
tell what was being sent to the model, or what the agent was about to do to my
files. DevWit makes both fully visible:

1. Context Panel — every LLM request lists its system prompt, tools, and each
   injected item (file, RAG chunk, terminal output) with token counts. Toggle
   any item off and the request shrinks accordingly.
2. Authorization Gate — the agent cannot write a file or run a shell command
   without your one-click approval. Approvals can be remembered per-project.
3. Lean context — a task router sends simple requests to local models (Ollama)
   and complex ones to cloud models, with a per-session cost ledger.

It's a real IDE, not a wrapper: TypeScript LSP (diagnostics/hover/definition),
integrated Git, breakpoint debugging (DAP/js-debug), MCP tool servers,
multi-agent orchestration, custom modes — all free, all open source.

v0.3.0 ships Windows/macOS/Linux builds verified by 614 unit tests and 28
end-to-end suites. No accounts, no cloud sync, telemetry is opt-in and off by
default.

I'd love your feedback — especially from teams with compliance/audit needs.
```

## Gallery 规格与素材映射

PH Gallery 推荐 **1270×760 px**（最低 635×380），PNG/JPG，建议 4–6 张。
仓库现成截图（docs/screenshots/，直接上传，命名即顺序）:

| 顺序 | 文件 | 展示卖点 |
|---|---|---|
| 1 | context-panel-rag.png | 上下文透明：逐项 token + 开关（核心差异点，放首图） |
| 2 | agent-authorization-gate.png | 授权门：文件/命令需逐次批准 |
| 3 | chat-diff-review.png | 对话式编程：diff 内联逐块接受/拒绝 |
| 4 | multi-agent-orchestration.png | 多 Agent 编排：Planner→并行子任务 |
| 5 | community-modes.png | 模式生态：自定义/社区模式 |
| 6 | settings-unified.png | 统一设置：模型/MCP/路由一站式 |

> 注意：PH 展示顺序即上图顺序，首图决定点击率。如需重新截 1270×760
> 标准尺寸，以同样顺序重拍即可。

- **Thumbnail**: 240×240 PNG（应用图标；若无方图，用 logo 居中纯色底导出）
- **Video（可选但推荐）**: ≤3 分钟，演示「上下文面板逐项开关 → 授权门拦截 → diff 接受」三连

## Hunter / Maker

- Maker: 用户本人 GitHub 账号（eeyzs1）
- 无需付费 Hunter；自荐发布 + 首日活跃回复评论效果相当
