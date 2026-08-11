# DevWit 增长运营简报 — 2026-08-11

> 接手目标：让更多人喜欢并持续使用 DevWit。手段 = 推广获客 → 开源信任 → 平台分发 → 反馈驱动迭代。

## 今日实测指标

| 指标 | 值 | 解读 |
|------|-----|------|
| GitHub stars / forks | **0 / 0** | SignPath 曾因公信号不足被拒；star 是信任门槛 |
| Latest | **v0.4.0**（2026-08-03） | 产品侧就绪 |
| v0.4.0 下载 | ≈0（仅 latest.yml=1） | 无人触达或 Windows SmartScreen 劝退 |
| v0.2.0 下载 | Win 17 / Mac 4 | PH 首发当天唯一真实峰值 |
| winget #407506 | OPEN，validation 通过，等 moderator | 不宜再频繁 ping（上次 8/6） |
| Homebrew tap | **已升至 0.4.0**（本轮修复） | 修复前卡在 0.3.0 |
| 根 README | **本轮对齐 v0.4.0**（待 push） | 修复前落地页仍链到 0.3.0 |

北极星：真实活跃用户。当前瓶颈是**分发与曝光**，不是功能缺口。

## 增长闭环（必须按序）

```
推广曝光 → GitHub 落地（README 转化 star）→ star 突破
    → 重申 SignPath → 签名包 → Windows 下载转化
    → winget 合并 → 包管理器自然流量
    → 反馈/Issue → 产品迭代 → 再发版再推广
```

## 本轮已执行（AI）

1. 根 `README.md` 从 v0.3.0 对齐到 **v0.4.0** + 差异化对比表 + Star CTA
2. Homebrew cask **0.3.0 → 0.4.0**（sha256 实证）并推送 `eeyzs1/homebrew-tap`
3. 开源卫生：`CONTRIBUTING.md` + Issue 模板（bug / feedback）
4. 反馈 backlog：`distribution/launch/GROWTH-FEEDBACK-BACKLOG.md`

## 用户必须亲自做（AI 无法代劳）

推广物料已就绪，缺账号发布。建议本周一次发完：

| 优先级 | 动作 | 物料 |
|--------|------|------|
| P0 | **Show HN**（美西周二–四 7–9 AM = 北京 22–24） | `promotion/reddit-hn.md` |
| P0 | **掘金**长文 | `promotion/juejin.md` |
| P0 | **dev.to** 英文帖（`published: true`） | `blog-devto-en.md` |
| P1 | Reddit r/programming（HN 后隔 1–2 天） | `promotion/reddit-hn.md` |
| P1 | B 站专栏或录屏 | `promotion/bilibili.md` |
| P1 | PH 帖巡检新评论 | https://www.producthunt.com/posts/devwit |

发帖后 2 小时在线回复；把流量尽量导向 GitHub（star）而非仅下载未签名 exe。

## 平台维护节奏

| 渠道 | 节奏 | 负责人 |
|------|------|--------|
| GitHub Releases | 功能里程碑打 tag；v0.5.0 编辑器增强已齐可择机发 | AI 准备 + 用户确认 tag |
| Homebrew | 每个 macOS Release 当日升 version/sha256 | AI |
| winget | #407506 合并后立刻提 0.4.0 update PR | AI（manifest 已在 `distribution/winget/.../0.4.0/`） |
| SignPath | star 有公开信号后再申请 | 用户申请，AI 接 CI |
| PH / 社区评论 | 每周巡检，转 Issue | AI 起草回复，用户发 |

## 产品优化原则（来自已有反馈）

PH 真实用户（Furkan / Ferdi）反复夸的是：

1. **逐项 token 成本可见可关**
2. **授权门默认开启**

下一迭代优先加深这两条差异化（成本可读性、授权体验），再扩 Rust LSP 等广度功能。详见反馈 backlog。

## 下一步建议（请用户拍板）

- [ ] 确认：我把本轮 README / CONTRIBUTING / Issue 模板 **commit + push 到 main**
- [ ] 本周内你完成 Show HN + 掘金 + dev.to 三连发
- [ ] 是否现在打 **v0.5.0** tag（编辑器 9 项增强已完成）作为下一波推广新闻点
- [ ] star ≥ 门槛后重申 SignPath
