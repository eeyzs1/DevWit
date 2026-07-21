# Finishing a Development Branch (Phase-Aware)

吸收自：union 框架 `skills/finishing-a-development-branch/SKILL.md`
触发：所有 Phase 完成后（post-audit）

## 核心原则

**验证测试 → 检测环境 → 呈现选项 → 执行选择 → 清理。**

**开始时宣布：** "我正在使用 finishing-a-development-branch 技能完成此工作。"

## 流程

### Step 1: 验证测试

**在呈现选项之前，验证测试通过：**

```bash
npm test / cargo test / pytest / go test ./...
```

**如果测试失败：** 停止。不进入 Step 2。显示失败并修复。
**如果测试通过：** 继续 Step 2。

### Step 2: 检测环境

```bash
GIT_DIR=$(cd "$(git rev-parse --git-dir)" 2>/dev/null && pwd -P)
GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd -P)
```

| 状态 | 菜单 | 清理 |
|------|------|------|
| `GIT_DIR == GIT_COMMON`（普通仓库） | 标准 4 选项 | 无 worktree 需清理 |
| `GIT_DIR != GIT_COMMON`，命名分支 | 标准 4 选项 | 基于来源检查 |
| `GIT_DIR != GIT_COMMON`，detached HEAD | 减少的 3 选项（无 merge） | 不清理（外部管理） |

### Step 3: 确定 Base 分支

```bash
git merge-base HEAD main 2>/dev/null || git merge-base HEAD master 2>/dev/null
```

### Step 4: 呈现选项

**普通仓库和命名分支 worktree — 呈现恰好 4 个选项：**

```
实现完成。你想做什么？

1. 本地合并回 <base-branch>
2. 推送并创建 Pull Request
3. 保持分支原样（我稍后处理）
4. 丢弃此工作

选择哪个？
```

**Detached HEAD — 呈现恰好 3 个选项：**

```
实现完成。你处于 detached HEAD（外部管理的工作空间）。

1. 作为新分支推送并创建 Pull Request
2. 保持原样（我稍后处理）
3. 丢弃此工作

选择哪个？
```

### Step 5: 执行选择

#### Option 1: 本地合并

```bash
MAIN_ROOT=$(git -C "$(git rev-parse --git-common-dir)/.." rev-parse --show-toplevel)
cd "$MAIN_ROOT"
git checkout <base-branch>
git pull
git merge <feature-branch>
<test command>
# 仅在合并成功且测试通过后：清理 worktree，然后删除分支
git branch -d <feature-branch>
```

#### Option 2: 推送并创建 PR

```bash
git push -u origin <feature-branch>
gh pr create --title "<title>" --body "..."
```
**不要清理 worktree** — 用户需要它来迭代 PR 反馈。

#### Option 3: 保持原样

报告："保持分支 <name>。Worktree 保留在 <path>。"
**不要清理 worktree。**

#### Option 4: 丢弃

**先确认：** 要求输入 'discard' 确认。
确认后：清理 worktree，然后强制删除分支：
```bash
git branch -D <feature-branch>
```

### Step 6: 清理工作空间

**仅在 Options 1 和 4 运行。** Options 2 和 3 始终保留 worktree。

```bash
# 如果 worktree 路径在 .worktrees/, worktrees/, 或 .meta-harness/worktrees/ 下
cd "$MAIN_ROOT"
git worktree remove "$WORKTREE_PATH"
git worktree prune  # 自我修复：清理任何过期的注册
```

## 快速参考

| Option | 合并 | 推送 | 保留 Worktree | 清理分支 |
|--------|------|------|--------------|---------|
| 1. 本地合并 | yes | - | - | yes |
| 2. 创建 PR | - | yes | yes | - |
| 3. 保持原样 | - | - | yes | - |
| 4. 丢弃 | - | - | - | yes (force) |

## 红线

**绝不：**
- 测试失败时继续
- 不验证合并结果上的测试就合并
- 未经确认删除工作
- 未经明确请求强制推送
- 确认合并成功前移除 worktree
- 清理不是你创建的 worktrees（来源检查）
- 在 worktree 内部运行 `git worktree remove`

**始终：**
- 呈现选项前验证测试
- 呈现菜单前检测环境
- 呈现恰好 4 个选项（或 detached HEAD 的 3 个）
- Option 4 要求输入确认
- 仅 Options 1 & 4 清理 worktree
- worktree 移除前 `cd` 到主仓库根目录
- 移除后运行 `git worktree prune`

## 在 Meta-Harness 中的上下文

- 此技能在**所有 Phase 完成且最终审计通过后**触发 — 是引擎流水线的最后一步
- 引擎的 `PHASE_VERIFY` 门（由 `verification` 技能驱动）必须在此技能激活前通过
- Worktree 来源检查使用 `.meta-harness/worktrees/` 识别 Meta-Harness 管理的 worktrees
- 选择的选项（merge / PR / keep / discard）记录为审计日志中的 `RUN_COMPLETE` 事件
- 如果用户选择"创建 PR"，引擎可选择设置后续运行来跟踪 PR 审查反馈
- 此技能也可从 `executing-plans` 和 `subagent-driven-dev` 作为它们的终端步骤到达