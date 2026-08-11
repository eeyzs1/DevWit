# DevWit 增长运营简报 — 2026-08-11

> 接手目标：让更多人喜欢并持续使用 DevWit。手段 = 推广获客 → 开源信任 → 平台分发 → 反馈驱动迭代。

## 今日实测指标（发版后 2026-08-11）

| 指标 | 值 | 解读 |
|------|-----|------|
| Latest | **v0.5.0**（已转正） | https://github.com/eeyzs1/DevWit/releases/tag/v0.5.0 |
| Homebrew tap | **0.5.0** | `eeyzs1/homebrew-tap@a5d88a7` |
| winget | #407506 仍 OPEN；**0.5.0 manifest 已入库** | 首包合并后提 update PR |
| GitHub stars | **0** | 下一步靠用户发帖带量 |

北极星：真实活跃用户。当前瓶颈是**分发与曝光**，不是功能缺口。

## 增长闭环（必须按序）

```
推广曝光 → GitHub 落地（README 转化 star）→ star 突破
    → 重申 SignPath → 签名包 → Windows 下载转化
    → winget 合并 → 包管理器自然流量
    → 反馈/Issue → 产品迭代 → 再发版再推广
```

## 本轮已执行（AI）

1. 根 `README.md` 对齐 Latest + 差异化对比表 + Star CTA（已 push）
2. Homebrew cask 跟到 **0.5.0**（sha256 实证）并推送 tap
3. 开源卫生：`CONTRIBUTING.md` + Issue/PR 模板
4. **打 tag 发布 v0.5.0**，CI 三平台成功，已转正 Latest
5. winget **0.5.0** 四分件入库（待 #407506 合并后提 PR）
6. 反馈 backlog：`GROWTH-FEEDBACK-BACKLOG.md`

## 用户必须亲自做（AI 无法代劳）

| 优先级 | 动作 | 说明 |
|--------|------|------|
| P0 | **打开代理/VPN** | 当前本机直连 HN / Reddit 超时；开代理后我即可用 CDP 发 Show HN |
| P0 | Show HN | 物料 `promotion/reddit-hn.md`；美西周二–四 7–9 AM 最佳（今晚北京 22–24） |
| P1 | Reddit r/programming | HN 后隔 1–2 天 |
| P1 | B 站 | 专栏/录屏 |

### 本轮已由浏览器 CDP 发布

| 平台 | 状态 | 链接 |
|------|------|------|
| **dev.to** | ✅ 已上线 | https://dev.to/eeyzs1/devwit-v050-an-open-source-ai-ide-with-a-transparent-context-panel-and-a-real-editor-onn |
| **掘金** | ⏳ 审核中 | https://juejin.cn/spost/7672325240563679286 |
| 掘金（旧文） | ✅ 仍在线 | https://juejin.cn/post/7667564845585465395 |
## 平台维护节奏

| 渠道 | 节奏 | 负责人 |
|------|------|--------|
| GitHub Releases | 功能里程碑打 tag；**v0.5.0 已发** | AI 准备 + 用户确认 tag |
| Homebrew | 每个 macOS Release 当日升 version/sha256 | AI（已跟 0.5.0） |
| winget | #407506 合并后立刻提 **0.5.0** update PR | AI（manifest 在 `.../0.5.0/`） |
| SignPath | star 有公开信号后再申请 | 用户申请，AI 接 CI |
| PH / 社区评论 | 每周巡检，转 Issue | AI 起草回复，用户发 |

## 产品优化原则（来自已有反馈）

PH 真实用户（Furkan / Ferdi）反复夸的是：

1. **逐项 token 成本可见可关**
2. **授权门默认开启**

下一迭代优先加深这两条差异化（成本可读性、授权体验），再扩 Rust LSP 等广度功能。详见反馈 backlog。

## 下一步建议

- [x] commit + push README / CONTRIBUTING / Issue 模板
- [x] 打 **v0.5.0** tag 并发版（Latest）
- [ ] 本周完成 Show HN + 掘金 + dev.to 三连发（用 v0.5.0 当新闻点）
- [ ] star 有公开信号后重申 SignPath
- [ ] winget #407506 合并后提 0.5.0 update PR
