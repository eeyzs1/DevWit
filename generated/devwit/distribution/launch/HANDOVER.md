# DevWit v0.3.0 三平台首发 — 交接文档

> 用途：新开聊天继续任务时，把本文件喂给 AI 即可恢复全部上下文。
> 更新于 2026-07-29（首发日前一天）。

## 一、平台状态总览

| 平台 | 状态 | 链接 / 证据 |
|---|---|---|
| dev.to | ✅ 已发布 | https://dev.to/eeyzs1/i-built-an-ai-ide-that-shows-you-exactly-what-it-sends-to-the-model-3jh8 |
| 掘金 | ✅ 已发布 | 证据 `evidence/juejin-12-now.png`（经 GitHub OAuth 登录，文章已提交发布） |
| Product Hunt | ⏰ 已定时 | **2026-07-30 12:01 AM PDT（北京时间 7/30 15:01）**，证据 `evidence/ph-35-myproducts.png` |

- PH 产品页：https://www.producthunt.com/products/devwit
- PH 上线后帖子页：https://www.producthunt.com/posts/devwit
- PH Pre-Launch 仪表盘（上线后转 Launch Day 仪表盘）：https://www.producthunt.com/products/devwit/devwit/prelaunch
- PH 编辑入口：https://www.producthunt.com/posts/devwit/edit

## 二、首发日（7/30）自动化——唯一待办

**Windows 计划任务 `DevWit-PH-FirstComment`** 将于 **7/30 15:03** 自动执行：
`distribution/launch/ph-first-comment.cmd` → `ph-first-comment.cjs`（轮询等上线→填 Maker 首评→提交→截图）。

### 两个前提（缺一不可）
1. 电脑开机且不休眠；
2. 发布用 Chrome 以 CDP 模式运行且 PH 登录有效。若浏览器被关，用以下命令重启（junction alias 指向真实 Chrome 配置，登录态在其中）：

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir=C:\Users\eeyzs1\chrome-ud-alias --remote-debugging-port=9222 --no-first-run --no-default-browser-check --disable-session-crashed-bubble --hide-crash-restore-bubble about:blank
```

### 验证结果
- 日志：`generated/devwit/distribution/launch/evidence/ph-first-comment.log`（`COMMENT POSTED: true` 即成功）
- 截图：`evidence/ph-41-comment-filled.png` / `ph-42-comment-posted.png`

### 失败兜底
手动跑（cwd = `generated/devwit`）：`node distribution\launch\ph-first-comment.cjs`
首评文案外置在 `distribution/launch/ph-first-comment.txt`，改文案不用动代码。
若评论框选择器失效，脚本会 dump DOM 到 `ph-40-comment-fail.png` + 日志，把 dump 喂给 AI 修选择器即可。

## 三、首发日当天人工/AI 协作事项

1. 15:01 后盯 Launch Day 仪表盘，**及时回复每条评论**（首日互动直接影响排名）；
2. 首评若自动发布失败，手动粘贴 `ph-first-comment.txt` 到帖子评论区；
3. 不要明示/暗示求 upvote（PH 规则，证据见 ph-28 弹窗）；可在自己的社交媒体分享链接。

## 四、首发日后清理

```
schtasks /Delete /TN "DevWit-PH-FirstComment" /F
```

junction alias `C:\Users\eeyzs1\chrome-ud-alias` 可保留（以后任何 PH/dev.to 自动化都能复用此 CDP 入口）。

## 五、关键文件清单（均在 generated/devwit/distribution/launch/）

| 文件 | 用途 |
|---|---|
| `product-hunt.md` | PH 全部素材（tagline/description/首评/图集顺序），数字均可追溯 |
| `blog-devto-en.md` / `blog-juejin-zh.md` | 已发布文章的源稿（frontmatter 含标题/标签） |
| `ph-first-comment.txt` | Maker 首评文案（外置） |
| `ph-first-comment.cjs` / `.cmd` | 首评自动化（计划任务目标） |
| `assets/ph-thumbnail.png` | PH 缩略图 |
| `evidence/*.png` | 全流程截图证据（devto-*/juejin-*/ph-*） |
| `signup-checklist.md` | 平台注册/发布 checklist |
| 仓库根 `launch-credentials.env` | PostHog 凭证（gitignored，严禁入库） |

## 六、环境备忘

- 代理：由用户代理客户端（Clash/V2Ray 等）自动分流，Chrome 不加 `--proxy-server` 参数；
- Chrome 150+ 禁止 CDP 连默认 profile → 用 junction alias 绕过（已建好）；
- 三平台均用 GitHub OAuth 登录（账号 eeyzs1），PH 用户名 @eeyzs1；
- Playwright 连浏览器统一 `chromium.connectOverCDP("http://localhost:9222")`。

## 七、后续增长线（首发日后继续）

- **SignPath**：OSS 代码签名申请表已提交（浏览器自动填表），等审核邮件（15763036963@163.com / eeyzs1@zoho.com）；
- **winget 过审**：签名落地后提交 winget-pkgs；
- **遥测观察**：PostHog（opt-in 默认关），项目凭证在 launch-credentials.env；
- **增长北极星**：10 万用户，里程碑 100→1k→10k（project_memory 有完整策略）。
