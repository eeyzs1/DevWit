# 用户注册清单（签名 / 首发 / 度量 / 内容渠道）

> 原则：账号必须用户本人注册；本清单给出每个平台的入口、所需材料、步骤、成本与注意事项。
> 代码侧基建已全部就位（release.yml 门控、遥测 opt-in、素材包），注册完成后即可开关启用。

## 1. 代码签名（P0 信任基建）——先选型，再注册

### ⚠️ 选型结论（2026-07 核实，来源：Microsoft Learn）

| 方案 | 成本 | 资格 | 结论 |
|---|---|---|---|
| Azure Artifact Signing（原 Trusted Signing） | ~$9.99/月 | 个人开发者**仅限美国/加拿大**；组织需美/加/欧盟/英 + 3 年税务记录 | **中国个人开发者不可用**；CI 门控已就绪，资格放宽后可即开即用 |
| **SignPath Foundation（推荐）** | **免费** | 开源项目（公开仓库、OSI 许可证），全球可申请 | **主路径**：与免费软件定位完全契合 |
| Certum OV 证书（备选） | ~€100/年（开源项目有折扣档） | 全球个人可申请 | 付费兜底 |

> SmartScreen 预期管理：除 Microsoft Store MSIX 外，任何签名方案都需积累信誉，
> 初期仍会有警告（签名保证的是身份可验证 + 防篡改，不是立即免警告）。

### 1a. SignPath Foundation（推荐主路径）

- **入口**: https://signpath.org/ → "Open Source" / foundation 申请
- **所需材料**: GitHub 仓库（eeyzs1/DevWit 公开 ✅）、OSI 许可证（仓库 LICENSE ✅）、
  项目简介、发布流程说明（GitHub Actions release.yml）
- **步骤**:
  1. 注册 SignPath 账号（GitHub OAuth）
  2. 提交 Foundation 开源项目申请，等待人工审核（数天到数周）
  3. 审核通过后创建 Project + Signing Policy（CI 模式，绑定 GitHub Actions）
  4. 取得 API token 后告诉我，我接入 release.yml（自定义签名钩子，工程量已在评估内）
- **成本**: $0
- **注意**: Foundation 要求发布构建必须来自公开 CI（我们 release.yml 已满足）

### 1b. Azure Artifact Signing（备选，资格放宽后启用）

CI 已完成：`release.yml` 以 `vars.AZURE_SIGN_ENABLED == 'true'` 门控，未启用自动跳过。

- **入口**: https://portal.azure.com → 创建 "Trusted Signing / Artifact Signing" 账户
- **步骤**（若将来资格满足）:
  1. Azure 订阅（按量付费）+ 注册 `Microsoft.CodeSigning` 资源提供程序
  2. 创建签名账户（区域决定 endpoint，如 `https://neu.codesigning.azure.net/`）
  3. 身份验证（门户内完成，1–20 个工作日）
  4. 创建证书配置文件（Public Trust）
  5. Microsoft Entra 应用注册 → 客户端密钥，授予 "Artifact Signing Certificate Profile Signer" 角色
  6. 配置 GitHub 仓库：
     - **Variables**: `AZURE_SIGN_ENABLED=true`、`AZURE_SIGN_PUBLISHER`（证书 CN）、
       `AZURE_SIGN_ENDPOINT`、`AZURE_SIGN_ACCOUNT`、`AZURE_SIGN_PROFILE`
     - **Secrets**: `AZURE_TENANT_ID`、`AZURE_CLIENT_ID`、`AZURE_CLIENT_SECRET`
  7. 打下一个 tag 即自动签名

## 2. Product Hunt 首发（素材已备：distribution/launch/product-hunt.md）

- **入口**: https://www.producthunt.com/
- **所需材料**: 个人头像、Twitter/LinkedIn（可选绑定）、素材包文案、6 张截图（docs/screenshots/）
- **步骤**:
  1. 注册账号并完善个人资料（首日评论权重与账号完整度相关）
  2. New Product → 按素材包填 Name/Tagline/Description/Topics/Links
  3. Gallery 按素材包顺序上传 6 张截图；Thumbnail 240×240
  4. 排期：周二至周四 00:01 PT（北京时间 15:01/16:01，注意夏令时）
  5. 发布后立刻粘贴 First Comment；当天保持在线回复
- **成本**: $0（无需付费 Hunter）
- **注意**: 发布前把 GitHub README 首屏英文化（README_EN.md 已有，确认默认 README 双语入口）

## 3. PostHog（遥测后端，opt-in 默认关闭已内建）

- **入口**: https://posthog.com/ → Sign up（Cloud US 或 EU 任选）
- **所需材料**: 邮箱
- **步骤**:
  1. 创建组织 + 项目（如 "devwit"）
  2. Project Settings 取 **Project token**（`phc_` 开头；不要给 `phx_` 开头的 Personal API key）与 **Host**（US=`https://us.i.posthog.com`，EU=`https://eu.i.posthog.com`）
  3. 告诉我 token + host，我写入默认遥测端点配置（应用内仍可由用户改端点/关闭）
- **成本**: $0（免费档 100 万事件/月，远超早期需求）
- **注意**: 与定位一致——遥测保持默认关闭、匿名、零内容采集，仅事件名/计数+版本+OS+随机 installId

## 4. dev.to（英文博客，稿已备：distribution/launch/blog-devto-en.md）

- **入口**: https://dev.to/ → Sign up（GitHub OAuth）
- **步骤**: New Post → 粘贴全文（front matter 已含 tags）→ `published: false` 改 `true`
  → 封面图用 context-panel-rag.png
- **成本**: $0
- **时机**: 与 Product Hunt 同日或提前 1 天，互相引流

## 5. 掘金（中文博客，稿已备：distribution/launch/blog-juejin-zh.md）

- **入口**: https://juejin.cn/ → 登录（手机号）
- **所需材料**: 手机号实名
- **步骤**: 写文章 → 粘贴全文 → 分类「前端/人工智能」→ 标签 AI/开源/Electron/效率工具
- **成本**: $0
- **注意**: 首图上传 docs/screenshots/context-panel-rag.png；文末 GitHub 链接保留

## 6. B 站（中文二次触达，可延后）

- **入口**: https://www.bilibili.com/ → 专栏投稿
- **步骤（轻量版）**: 将掘金稿适配为专栏文章；**进阶版**（推荐后续做）：录 3 分钟演示视频
  （上下文面板逐项开关 → 授权门拦截 → diff 接受），专栏+视频互链
- **成本**: $0

## 7. 已在途（无需操作）

- **winget**: PR microsoft/winget-pkgs#407506 审核中，CLA 已签、校验已过，等待 moderator 合入
- **Homebrew tap（可选，延后）**: homebrew/devwit.rb 已备，需建 eeyzs1/homebrew-tap 仓库后纳入

## 建议执行顺序

1. **SignPath Foundation 申请**（审核周期最长，先排队）
2. Product Hunt + dev.to + 掘金 同日三连发（素材全部就绪，只欠账号）
3. PostHog 注册（10 分钟，给我 key 即接入）
4. B 站专栏跟进（首发后一周内）
