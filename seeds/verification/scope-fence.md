# Scope Fence — 文件级修改边界

## 原则

**Agent 可以看整个项目的代码（理解上下文），但只能修改 Phase spec 声明的文件范围。**
任何越界修改在 PHASE_VERIFY 时被捕获为 `AUDIT_GAP`。

---

## Phase Spec 中的 Scope 声明

每个 Phase spec 必须包含一个 `Scope` 部分：

```markdown
## Scope

### Allowed (可修改)
- `src/auth/login.ts` — 核心登录逻辑
- `src/auth/login.test.ts` — 登录测试

### Read-Only Reference (可阅读，不可修改)
- `src/auth/types.ts` — 类型定义
- `src/shared/api.ts` — API 客户端

### Forbidden (禁止触碰)
- `src/payment/` — 支付模块（独立子系统）
- `database/migrations/` — 数据库迁移（需 DBA 审核）
```

---

## 验证协议

### 每 Phase 结束时

```bash
# 获取本 Phase 的所有变更
PHASE_DIFF=$(git diff --name-only HEAD~1 HEAD)

# 交叉检查 Scope
for FILE in $PHASE_DIFF; do
  if FILE in Allowed → PASS
  elif FILE in Read-Only Reference → AUDIT_GAP ("read-only file modified")
  elif FILE in Forbidden → AUDIT_GAP ("forbidden zone breached")
  else → AUDIT_GAP ("unscoped file change")
done
```

### 输出格式

```
SCOPE_CHECK
Phase: 2 — Implement login
Scope allowed: 2 files

Files changed: 3
  src/auth/login.ts          — OK (allowed)
  src/auth/login.test.ts     — OK (allowed)
  src/shared/config.ts       — SCOPE VIOLATION (not in scope)

Verdict: AUDIT_GAP — 1 scope violation
```

---

## 大项目的增量上下文策略

对于超过 1000 文件的仓库，Phase spec 应使用以下结构组织上下文：

### 1. 仓库地图（由 summarize-repo.sh 生成，~200 行）

```
src/
  auth/          — 认证模块（本 Phase 目标区域）
  payment/       — 支付模块（不相关）
  shared/        — 共享工具和类型
  ...
```

### 2. 相关文件摘要

Phase spec 应包含该 Phase 需要理解和修改的关键文件的摘要，而非完整内容：
```markdown
## Context Summary

### src/auth/login.ts (需要修改)
- `LoginHandler.handle()` — 主入口，当前使用 session，需改为 JWT
- `validateCredentials()` — 凭证验证逻辑（不变）
- 依赖: `src/shared/api.ts::ApiClient`（只读）

### src/auth/types.ts (只读参考)
- `LoginRequest` — { email: string, password: string }
- `LoginResponse` — { token: string, user: User }
```

### 3. Agent 确认

Agent 在开始前必须确认：Scope 和 Context Summary 是否足够理解任务？如果不够 → 请求补充，再开始。

---

## 与 Baseline Diff 的关系

Scope Fence 和 Baseline Diff 互补：
- **Baseline Diff** — 检测"改了什么"（事后审计）
- **Scope Fence** — 限制"能改什么"（事前声明）

两者在 `PHASE_VERIFY` 中合并输出：
```
PHASE_VERIFY
...
Scope Check:
- Allowed changes: 2/2 in scope
- Scope violations: 1 (src/shared/config.ts)

Baseline Diff:
- Expected: 2 / Unexpected: 1
```