# Snapshot & Rollback — Phase 级快照回滚

## 原则

**每 Phase 开始前自动创建快照（git branch）。失败时一键回滚，不影响主分支。**

---

## 自动快照

### Phase 开始时

Executor 在 `PHASE_START` 后立即执行：

```bash
# 保存当前状态为快照
git checkout -b meta-harness/phase-N-<run-id>
# 如果 Phase 有依赖，从上一个 Phase 的快照分支创建
```

### 文件结构
```
main
├── meta-harness/phase-1-Ab3Kx9    ← Phase 1 工作分支
│   └── meta-harness/phase-2-Ab3Kx9    ← Phase 2 工作分支（从 phase-1 切出）
│       └── meta-harness/phase-3-Ab3Kx9    ← Phase 3 工作分支
```

---

## 回滚策略

### Phase 失败时

```bash
# 选项 1: 回滚到 Phase 开始前，保留工作分支供检查
git checkout main
# meta-harness/phase-N-<run-id> 分支保留，用户可以检查发生了什么

# 选项 2: 回到上一 Phase 的干净状态
git checkout meta-harness/phase-<N-1>-<run-id>
git branch -D meta-harness/phase-N-<run-id>
```

### 3-Strike 升级路径

```
Strike 1:  自动重试同一 Phase（不创建新快照）
Strike 2:  回滚 → 写 fix-spec → 从快照重新执行
Strike 3:  回滚 → 回到 main → HANDOFF 给用户
```

---

## 批量提交

### Phase 成功时

```bash
# 所有 Phase 完成后，将所有快照合并回 main
git checkout main
git merge meta-harness/phase-<last>-<run-id>

# 清理快照分支
git branch -d meta-harness/phase-1-<run-id>
git branch -d meta-harness/phase-2-<run-id>
...
```

### 或者：每 Phase 独立合并（更安全）

```bash
# Phase N 完成后立即合并回 main
git checkout main
git merge meta-harness/phase-N-<run-id>
git branch -d meta-harness/phase-N-<run-id>
# 这种方式的优点：Phase N 失败不影响已合并的 Phase 1..N-1
```

配置项：`project.yaml` → `branch.merge_strategy` → `batch` | `incremental`

---

## 大项目专用策略

对于大型仓库（clone/checkout 慢），使用 git worktree 代替分支：

```bash
# 为 Phase N 创建独立 worktree
git worktree add .meta-harness/worktrees/phase-N-<run-id> main

# 在其中工作...

# Phase 成功 → 合并 → 删除 worktree
git -C .meta-harness/worktrees/phase-N-<run-id> push origin main
git worktree remove .meta-harness/worktrees/phase-N-<run-id>

# Phase 失败 → 直接删除 worktree
git worktree remove --force .meta-harness/worktrees/phase-N-<run-id>
```

Worktree 优点：
- 无需切换分支（保持 main 干净）
- 并行 Phase 的可能（不同 worktree 互不干扰）
- 删除 worktree 比 `git reset --hard` 更安全