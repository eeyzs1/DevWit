# Baseline Diff Check — 意外变更检测

## 与 Scope Fence 的关系

Baseline Diff 和 Scope Fence 互补（见 `seeds/verification/scope-fence.md`）：
- **Scope Fence** — 限制"能改什么"（事前声明，Phase spec 中定义）
- **Baseline Diff** — 检测"改了什么"（事后审计，PHASE_VERIFY 中检查）

两者在 `PHASE_VERIFY` 中合并输出：
```
PHASE_VERIFY
...
Scope Check:
- Files in allowed scope: <count>/<total>
- Scope violations: <count> (<file>)

Baseline Diff (vs Baseline ref):
- Expected changes: <count>
- Unexpected changes: <count>
```

## 原则

**Phase 声称的变更范围必须与实际 diff 一致。** 任何 Phase spec 声明的 `deliverables` 列表之外的变更都是 `AUDIT_GAP`。

## 机制

### 1. 捕获 Baseline（Planner Stage 7）

```
Baseline ref: git rev-parse HEAD
```
写入 `STATE.md`。这是所有后续对比的基准。

### 2. 每 Phase 结束时检查

```bash
# 对比 baseline 和当前工作树的完整 diff
git diff --name-status <baseline-ref> HEAD
```

输出格式：
```
M    src/auth/login.ts
A    tests/auth/login.test.ts
M    src/shared/config.ts    ← 检查是否在 Phase spec 的 deliverables 中
```

### 3. 分类变更

| 类别 | 条件 | 动作 |
|------|------|------|
| **Expected** | 文件在 Phase spec 的 `deliverables` 列表中 | ✅ 通过 |
| **Unexpected** | 文件不在任何 Phase spec 中 | ❌ `AUDIT_GAP` |
| **Scope creep** | 文件在 spec 中但该 Phase 声明不需要改它 | ⚠️ `AUDIT_NOTE` |

### 4. 验证输出格式

```
BASELINE_DIFF_CHECK
Baseline: <ref>
Current: HEAD
Expected changes: <count> files
Actual changes: <count> files

Expected:
  M src/auth/login.ts (Phase 2)
  A tests/auth/login.test.ts (Phase 2)

Unexpected:
  M src/shared/config.ts ← NOT in any Phase spec
  M package.json ← NOT in any Phase spec

Verdict: AUDIT_GAP — 2 unexpected file changes
```

## 集成到 PHASE_VERIFY

在 `PHASE_VERIFY` 块中添加：

```
PHASE_VERIFY
...
Baseline Diff (vs Baseline ref):
- Expected changes: <count>
- Unexpected changes: <count>
  - <file>: <reason>
Files changed: <count>
Notable diffs:
- <file>: <one-line summary>
```

## 集成到 Audit

在 Auditor 的 Round 1:
- 重新运行 baseline diff，覆盖所有 Phase
- 检查每个 Phase 的预期变更是否与实际变更一致
- 任何 unexpected 变更 → `AUDIT_GAP`

## 例外

以下变更是允许的，不在检查范围内：
- `.meta-harness/runs/` 目录下的文件
- `node_modules/`, `.git/`, `dist/`, `build/` 等构建产物
- lock 文件（`package-lock.json`, `yarn.lock` 等）— 标记为 `AUDIT_NOTE`
- `.env` 变化 — 标记为 `AUDIT_NOTE`（需人工确认）

## 大项目策略

对于大型仓库（>1000 文件），使用 `subtree` 检查：
```bash
# 只检查 Phase spec 声明的目录
git diff --name-only <baseline-ref> HEAD -- src/auth/ tests/auth/
```
这避免了全量扫描的大 token 消耗。