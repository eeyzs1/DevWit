# Leaf Protocol — Supervisor/Leaf 两级调度协议

吸收自：union 框架 `engine/leaf-protocol.md`
用途：定义 Supervisor/Leaf 两级调度中 leaf agent 的输入输出契约

---

## 核心概念

一个 **leaf agent** 是被 Supervisor 派发的短生命周期子 Agent，负责执行一个独立的、有边界的任务。Leaf 之间不通信，不共享状态，不继承 Supervisor 的上下文。

```
Supervisor (主 Agent)
  ├── Leaf 1: explorer  →  explore codebase, find patterns
  ├── Leaf 2: worker    →  implement a specific task
  ├── Leaf 3: tester    →  run tests, verify behavior
  └── Leaf 4: reviewer  →  review code against spec
```

**禁止 depth > 2。Leaf 不得再创建 agent。**

---

## 输入：task.json

Supervisor 为每个 leaf 生成一个 `task.json`：

```json
{
  "schemaVersion": 1,
  "taskId": "T1",
  "role": "worker",
  "objective": "Implement the login API endpoint at POST /api/auth/login",
  "scope": "Backend auth module only. Do not touch frontend or middleware.",
  "context": {
    "spec": "The endpoint should accept { email, password }, validate against the users table, and return a JWT token on success. Return 401 on invalid credentials.",
    "existingPatterns": "Follow the pattern in src/api/users.ts for error handling and response format.",
    "relatedFiles": ["src/db/users.ts", "src/middleware/auth.ts", "src/types/auth.ts"]
  },
  "allowedRepos": ["/abs/path/to/backend"],
  "allowedFiles": ["src/api/auth/login.ts", "tests/api/auth/login.test.ts"],
  "allowedCommands": ["npm run build", "npm test -- tests/api/auth/"],
  "forbiddenSideEffects": ["git-push", "trigger-ci", "edit-master", "npm install"],
  "evidenceDir": ".meta-harness/runs/<id>/phases/phase-N/evidence/T1/",
  "timeoutMinutes": 15
}
```

### 字段说明

| 字段 | 必填 | 说明 |
|---|---|---|
| `taskId` | ✓ | 唯一任务 ID |
| `role` | ✓ | `explorer` / `worker` / `tester` / `reviewer` |
| `objective` | ✓ | 一句话目标 |
| `scope` | ✓ | 明确边界 |
| `context.spec` | ✓ | 完整规格（不是路径，是内容） |
| `context.existingPatterns` | — | 要遵循的现有模式 |
| `context.relatedFiles` | — | 相关文件路径 |
| `allowedRepos` | ✓ | 允许操作的仓库 |
| `allowedFiles` | — | 允许的文件范围（超范围拒绝） |
| `allowedCommands` | — | 允许的命令白名单 |
| `forbiddenSideEffects` | ✓ | 禁止的副作用 |
| `evidenceDir` | ✓ | 证据保存路径 |
| `timeoutMinutes` | — | 超时（默认 15 分钟） |

---

## 输出：result.json

Leaf 完成后写入 `result.json`：

```json
{
  "schemaVersion": 1,
  "taskId": "T1",
  "verdict": "PASS",
  "summary": "Implemented POST /api/auth/login. Returns JWT on valid credentials, 401 on invalid. 5 tests pass.",
  "findings": [
    { "severity": "medium", "message": "Password hashing uses bcrypt with 10 rounds — consider 12 for production" }
  ],
  "changedFiles": [
    "src/api/auth/login.ts",
    "tests/api/auth/login.test.ts"
  ],
  "commandsRun": [
    { "command": "npm run build", "exitCode": 0 },
    { "command": "npm test -- tests/api/auth/", "exitCode": 0, "output": "5 passed, 0 failed" }
  ],
  "evidence": [
    { "kind": "test-report", "path": "/abs/path/to/evidence/test-output.txt" },
    { "kind": "screenshot", "path": "/abs/path/to/evidence/api-response.png" }
  ],
  "risksOrBlockers": [],
  "nextRequiredAction": null
}
```

### Verdict 值

| Verdict | 含义 | Supervisor 行为 |
|---|---|---|
| `PASS` | 任务完成，所有标准满足 | 继续下一个任务 |
| `PASS_WITH_CONCERNS` | 完成但有疑虑 | 阅读 concerns，判断是否需要处理 |
| `NEEDS_CONTEXT` | 需要更多信息 | 提供缺失信息，重新派发 |
| `FAIL` | 任务失败 | 进入 3-strike 恢复 |
| `BLOCKED` | 无法完成 | 检查原因：上下文不足？模型能力不够？任务太大？ |

---

## 角色定义

### explorer
- **目标**：探索代码库，寻找模式、惯例、风险
- **输入**：探索问题、目标目录
- **输出**：发现的模式、相关文件、风险标记
- **禁止**：修改任何文件

### worker
- **目标**：实现一个具体的、有边界的任务
- **输入**：完整规格、现有模式、允许文件
- **输出**：变更的文件、通过的测试、证据
- **禁止**：修改范围外的文件、触发 CI

### tester
- **目标**：运行测试、验证行为、报告结果
- **输入**：测试范围、命令
- **输出**：测试结果、失败详情、证据
- **禁止**：修改任何代码

### reviewer
- **目标**：对照规格审查代码
- **输入**：规格、变更文件、审查标准
- **输出**：审查结论、发现、建议
- **禁止**：修改任何代码

---

## Leaf Agent 约束

- **不得修改 master/main 分支** — leaf 只能在自己的分支上工作
- **不得创建更多 agent** — depth 最大为 2
- **不得触发 CI** — Leaf 的操作必须是本地安全的
- **不得修改 scope 外的文件** — 超出 `allowedFiles` 的修改会被拒绝
- **不得与其他 Leaf 通信** — Leaf 之间不共享状态
- **超时自动终止** — 超过 `timeoutMinutes` 的 Leaf 会被强制终止
- **必须写 result.json** — 无论成功或失败，Leaf 必须产出结果

---

## 实现指南

任何 executor adapter 都可以实现 leaf 协议：

1. 读取 `task.json`
2. 构建 leaf agent 的上下文（不继承 Supervisor 的历史）
3. 派发 leaf agent
4. 等待 leaf agent 写入 `result.json`
5. 读取 `result.json`，返回给 Supervisor

adapter 决定如何 spawn leaf agent（子进程、远程 API、IDE 插件），框架只关心 task.json 和 result.json。