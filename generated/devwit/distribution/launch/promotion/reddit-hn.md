# Reddit + Hacker News 推广内容

## 发帖位置
- **Hacker News**: `Show HN` 帖（标题 + 正文 + 评论区互动）
- **Reddit**: r/programming（主投）、r/webdev、r/selfhosted、r/opensource（可交叉投，注意各版规禁止同一内容多版重复，建议主投 r/programming，其余视情况）

## 账号注意
用匿名账号发，不暴露真名。文中只出现 GitHub 用户名 eeyzs1。不要在正文放任何个人社交链接。

---

## Hacker News — Show HN

**标题:**

```
Show HN: DevWit – AI IDE that shows exactly what it sends to the LLM
```

**正文 (text field):**

```
I built a desktop AI IDE where every LLM request is fully transparent: you see the system prompt, the tool list, each injected code chunk / RAG hit / terminal output, and the token cost of each item — and you can toggle any of them off before sending.

The agent mode has an authorization gate: file writes and shell commands require one-click approval, and every decision is logged in the execution trace. The context manifest can be exported as JSON for audit.

It's a standalone IDE (not a VS Code plugin) with a self-built editor kernel (piece-table buffer + Canvas rendering + tree-sitter), TypeScript + Python LSP, Git, DAP debugging, MCP server support, and multi-agent orchestration.

MIT licensed, free, no accounts, no cloud sync, telemetry opt-in off by default. 747 unit tests, three-platform builds (Windows / macOS / Linux).

GitHub: https://github.com/eeyzs1/DevWit

I built it because I was uncomfortable not knowing what AI coding tools were actually sending on my behalf, and wanted to control the cost and approve actions before they happened. Happy to answer questions about the architecture or the context engine.
```

**评论互动预案（有人问时回复方向）:**
- "How is this different from Cursor?": 上下文面板逐项可见可关 + 授权门 + 独立 IDE 非插件 + MIT 开源零账号
- "Why not just use VS Code + Continue?": Continue 是插件，上下文不透明，无授权门，无审计 manifest；DevWit 是独立 IDE，自研内核
- "Self-built editor vs Monaco?": piece-table + Canvas 渲染，tree-sitter 高亮，避开 Monaco 的 DOM 重绘开销，IME/多光标/折叠/minimap 全实现
- "Is the context transparency really useful or just novelty?": 逐项可关 = 主动控制 token 成本；manifest 落盘 = 审计材料；合规场景刚需

---

## Reddit — r/programming

**标题:**

```
I built an open-source AI IDE that shows every token it sends to the LLM — and makes every agent action require your approval
```

**正文:**

```
Most AI coding tools are black boxes. You ask a question, it answers — but you don't see what got sent to the model, how many tokens it cost, or what the agent is about to do to your files until it's done.

I'm a developer who got uncomfortable with that, so I built DevWit — a desktop AI IDE with two core ideas:

**1. Full context transparency.** Every LLM request shows its complete context: system prompt, tool list, each injected code chunk / RAG retrieval hit / terminal output — with the token cost of each item. Any item can be toggled off, and the request shrinks in real time. The context manifest can be exported as JSON.

**2. Authorization gate.** In agent mode, file writes and shell commands require one-click approval before execution. Every authorization decision is logged in the trace. You can approve per-action or remember per-project.

It's a standalone IDE, not a VS Code plugin:
- Self-built editor kernel (piece-table buffer + Canvas rendering + tree-sitter syntax highlighting)
- LSP: TypeScript/JavaScript + Python (pyright) — completion, references, rename, signature help, document outline
- Git: branch management, stash, blame, merge conflict resolution
- DAP debugging: conditional breakpoints, watch expressions, log points, attach to running process
- MCP server support (managed in settings, tools gated through authorization)
- Multi-agent orchestration ("command deck" mode auto-decomposes tasks into parallel sub-agents)
- Transparent RAG (retrieval hits shown with similarity score and token cost, individually removable)

MIT licensed. Free. No accounts, no cloud sync, no paywall. Telemetry is opt-in and off by default — zero content collected. 747 unit tests, three-platform builds.

Zero-cost model access built in: Ollama local (no API key needed, works fully offline), DeepSeek / OpenRouter free tiers via keyless channels, plus custom Anthropic / OpenAI-compatible endpoints.

GitHub: https://github.com/eeyzs1/DevWit
Releases: https://github.com/eeyzs1/DevWit/releases

I'm sharing this because I think "what did the AI actually send?" is a question more developers should be able to answer, and it shouldn't be locked behind a subscription. Happy to discuss the architecture, the context engine design, or the editor kernel.
```

---

## 发帖时机建议
- **HN**: 美西时间周二-周四 7-9 AM（北京时间周二-周四 22-24 点）流量最佳，避开周一/周五/周末
- **Reddit r/programming**: 美东时间工作日上午 8-10 点发
- 两个平台不要同时发，建议 HN 先发，隔 1-2 天再发 Reddit（避免内容被判定为 spam 跨平台轰炸）
- 发帖后 2 小时内务必在线回复评论（算法权重高）

## 回复原则
- 技术问题详答，体现工程深度
- 被质疑"重复造轮子"时：承认 Monaco/VS Code 成熟，但解释自研内核是为了上下文面板与渲染层的深度集成 + 规避插件沙箱限制
- 不主动提 star 数（显得乞讨）；有人问采纳情况时如实说早期阶段
- 不放任何个人社交账号 / 微信 / 邮箱
