# 用户反馈 → 产品优化 Backlog — 2026-08-11

来源：Product Hunt 首发真实评论（Furkan、Ferdi）+ 既有迭代反馈轨迹 + 分发阻塞观察。

## 已验证的差异化（必须守住）

| 信号 | 原文要旨 | 产品含义 |
|------|----------|----------|
| Token 成本拆解 | “token cost breakdown per request is honestly really useful” | 上下文面板逐项 token 是核心卖点，任何 UI 改动不得削弱 |
| 逐项可关 | “per-item token cost toggle is a clever touch” | 开关必须实时缩小请求；manifest 审计保留 |
| 授权门默认开 | “Love that the approval step is baked in by default” | 默认最严；白名单学习（AC29）是减摩擦，不是削弱默认 |

## P0 — 让现有卖点更好被发现（增长向）

| ID | 项 | 理由 | 状态 |
|----|----|------|------|
| G1 | 首次会话强制亮一次「上下文面板」导览 | PH 夸的是用过才懂的能力；新用户可能看不到 | **已做**（`context-tour.ts`，`onboarding.state.contextTourSeen`） |
| G2 | 用量行 / 成本估算在对话完成时更醒目 | Ferdi/Furkan 关心 budget；AC35/36 已有基建，需首屏可见 | **已做**（对话/活动流用量行样式 + 成本；状态栏回显） |
| G3 | Windows 未签名下载页诚实提示 + 绕过步骤 | v0.4.0 近 0 下载，SmartScreen 是转化杀手 | **已做**（根 README + `generated/devwit/README{,_EN}.md`） |
| G4 | README / 推广统一话术：透明上下文 + 授权门 | 避免功能清单淹没差异化 | 本轮根 README 已对齐 |

## P1 — 留存与信任

| ID | 项 | 理由 | 状态 |
|----|----|------|------|
| R1 | 攒 star 后重申 SignPath | 未签名阻断 Windows | 等 star |
| R2 | winget 0.2.0 合并 → 提 0.4.0 | 包管理器自然流量 | 等 moderator |
| R3 | v0.5.0 发版（编辑器 9 项） | 给推广一个新新闻点 | **已发** Latest |
| R4 | PostHog 事件 install/activate/session_start | 没有激活数据就无法优化漏斗 | **已做**（仍 opt-in；`TelemetryService` + ProvidersUpsert→activate） |

## P2 — 广度（勿抢跑于曝光）

| ID | 项 | 备注 |
|----|----|------|
| B1 | Rust LSP（rust-analyzer） | 体积评估后再做 |
| B2 | 更多社区模式 / MCP 条目 | 生态飞轮，依赖用户量 |

## 巡检清单（每周）

1. [ ] GitHub Issues / Discussions 新帖
2. [ ] Product Hunt 帖子新评论 → 用 `reply-furkan.cjs` 或手动回复 → 转本 backlog / Issue
3. [ ] Show HN / Reddit / 掘金 评论
4. [ ] Releases 下载量 + stars 周环比
5. [ ] Homebrew / winget 是否落后于 Latest

## 决策规则

- 有真实用户原话支撑的优化 > 想象中的功能清单
- 能提高「看清 AI 发了什么 / 批准前可控」的体验 > 新语言 LSP
- 没有曝光的功能迭代 = 库存积压；功能里程碑应绑定一波推广
