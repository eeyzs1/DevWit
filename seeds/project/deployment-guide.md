# 引用式部署方案 — Git Submodule

## 问题

当前方案：复制粘贴框架文件到每个项目。框架更新后，已有项目不受益。

## 方案：Git Submodule

```
your-project/
├── AGENTS.md              ← 引导文件，引用 submodule（唯一需复制的文件）
├── meta-harness/          ← git submodule → meta-harness 仓库（框架代码）
│   ├── AGENTS.md          ← 完整操作指令
│   ├── meta/              ← 解释器、生成器、工厂
│   ├── seeds/             ← 所有种子模板
│   └── scripts/           ← 所有脚本
├── .meta-harness/         ← 本地专属（不提交到 submodule）
│   ├── project.yaml       ← 唯一需编辑的文件
│   ├── runs/              ← 运行时产物
│   └── memory/            ← 项目记忆
└── .gitmodules
```

---

## 泛化入口：一句话更新/安装任何项目

**不管项目现在是什么状态，一个命令搞定：**

```bash
# Linux/Mac
bash <(curl -sSL https://raw.githubusercontent.com/eeyzs1/meta_harness/main/scripts/bootstrap-update.sh)

# Windows
powershell -ExecutionPolicy Bypass -Command "iwr https://raw.githubusercontent.com/eeyzs1/meta_harness/main/scripts/bootstrap-update.ps1 | iex"
```

自动检测四种状态并执行正确操作：

| 检测到 | 自动操作 |
|--------|----------|
| submodule 安装 | 运行 `update-harness` — 拉取最新框架 |
| 旧版根目录复制 | 运行 `migrate-legacy` — 迁移到 submodule |
| 旧版 .meta-harness/ | 运行 `migrate-legacy` — 迁移到 submodule |
| 未安装 | 提供安装指引，确认后自动安装 |

**这个命令不依赖项目内已有 meta-harness。** 在哪都能跑。

> 项目内的 AGENTS.md 引导文件也会在 agent 启动时自动检查更新（Bootstrap 第 1 步）。

---

## 新项目初始化

**自动检测 SSH / HTTPS（推荐）**

```bash
# Linux/Mac — 脚本会自动选 SSH 或 HTTPS
bash <(curl -sSL https://raw.githubusercontent.com/eeyzs1/meta_harness/main/scripts/install.sh)

# Windows — 脚本会自动选 SSH 或 HTTPS
powershell -ExecutionPolicy Bypass -Command "iwr https://raw.githubusercontent.com/eeyzs1/meta_harness/main/scripts/install.ps1 | iex"
```

`install` / `bootstrap-update` 会按以下顺序探测并选用第一个可达的协议：
1. SSH (`git@github.com:eeyzs1/meta_harness.git`) — 5 秒超时
2. HTTPS (`https://github.com/eeyzs1/meta_harness.git`) — 5 秒超时
3. 显式 URL 覆盖：`MH_REPO_URL` 环境变量，或 `bash install.sh <url>`

**手动指定协议**

```bash
# 1. 进入你的项目根目录
cd ~/my-project

# 2. 显式添加 meta-harness 为 submodule（强制 HTTPS）
git submodule add https://github.com/eeyzs1/meta_harness.git meta-harness
# 或强制 SSH
git submodule add git@github.com:eeyzs1/meta_harness.git meta-harness

# 3. 运行初始化脚本
# Linux/Mac
bash meta-harness/scripts/init-harness-submodule.sh
# Windows
powershell meta-harness/scripts/init-harness-submodule.ps1

# 4. 编辑 .meta-harness/project.yaml
#    - 设置 project.name
#    - 设置 repos
#    - 选择 adapters

# 5. 提交
git add meta-harness .meta-harness AGENTS.md .gitmodules
git commit -m "Add meta-harness framework"
```

---

## 已有项目更新框架

已有 submodule 的项目：

```bash
# Linux/Mac
bash meta-harness/scripts/update-harness.sh

# Windows
powershell meta-harness/scripts/update-harness.ps1
```

`update-harness` 内部使用 `pull_with_fallback` / `Invoke-PullWithFallback`：先沿用已配置的 remote 拉取，失败则临时切到另一种协议重试；成功后会还原原来的 remote URL，保留用户的协议偏好。

Agent 会在每次启动时自动检测并执行更新（见 AGENTS.md 第 1 步）。

---

## 已有项目迁移（从复制粘贴到 submodule）

```bash
# Linux/Mac
cd ~/my-old-project
bash meta-harness/scripts/migrate-legacy.sh

# Windows
cd ~/my-old-project
powershell meta-harness/scripts/migrate-legacy.ps1
```

迁移脚本做 5 步：备份 → 清理旧框架文件 → 添加 submodule → 恢复本地文件 → 生成项目级 AGENTS.md。

---

## 目录职责

| 路径 | 谁拥有 | 更新方式 |
|------|--------|----------|
| `meta-harness/` | 框架（submodule） | `git pull` in submodule |
| `.meta-harness/project.yaml` | 你 | 手动编辑 |
| `.meta-harness/runs/` | 运行时 | 自动生成 |
| `.meta-harness/memory/` | 运行时 | 自动生成 + 手动审查 |
| `AGENTS.md` | 引导文件 | init 时生成，通常不改 |

---

## 锁定版本（可选）

```bash
# 锁定到特定 tag/commit
cd meta-harness
git checkout v2.1.0
cd ..
git add meta-harness
git commit -m "Pin meta-harness to v2.1.0"
```

推荐：在稳定版本上用 tag 锁定。需要新特性时手动升级，而不是自动拉最新。

---

## CI/CD 中使用

在 CI 环境中，meta-harness 的 agent 不会自动更新（避免 CI 中产生意外变更）。需要手动处理：

```yaml
# GitHub Actions 示例
jobs:
  build:
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: 'recursive'
      
      - name: Lock meta-harness version
        run: |
          cd meta-harness
          git fetch --tags
          git checkout v2.0.0   # 锁定稳定版本
      
      - name: Health check
        run: bash meta-harness/scripts/verify.sh
```

**CI 环境中的关键原则：**
- 使用 `submodules: 'recursive'` 检出时自动拉取 submodule
- 锁定 tag 版本，不使用自动更新
- 在 CI 开始前运行 `verify.sh` 检查框架完整性
- 如果使用 `--mode fast`，跳过 code-review 和 brainstorming 阶段

---

## 快捷命令速查

| 场景 | Linux/Mac | Windows |
|------|-----------|---------|
| 泛化更新入口 | `bash <(curl -sSL .../bootstrap-update.sh)` | `powershell ... bootstrap-update.ps1 \| iex` |
| 新项目安装 | `bash <(curl -sSL .../install.sh)` | `powershell ... install.ps1 \| iex` |
| 更新框架 | `bash meta-harness/scripts/update-harness.sh` | `powershell meta-harness/scripts/update-harness.ps1` |
| 健康检查 | `bash meta-harness/scripts/verify.sh` | `powershell meta-harness/scripts/verify.ps1` |
| 移除框架 | `bash meta-harness/scripts/uninstall.sh` | `powershell meta-harness/scripts/uninstall.ps1` |