# Adapter Interfaces — 标准化适配器接口模板

吸收自：union 框架 `adapters/*/interface.md`
用途：定义所有生成 harness 项目的适配器标准接口合约

---

## 概述

适配器（Adapter）抽象外部系统。所有适配器遵循统一接口模式：
- 一套接口定义
- N 种实现（file, github-issues, jira, noop, github-actions, sub-agent, claude-goal, codex-task）
- 全部配置驱动，从 `project.yaml` 读取

---

## 1. Work-Item Adapter

抽象工单/追踪系统（GitHub Issues, Jira, Linear, 本地文件）。

### 接口方法

```yaml
create(item: WorkItemCreate) → item_id: string
get(item_id: string) → WorkItem
update(item_id: string, changes: WorkItemUpdate) → WorkItem
transition(item_id: string, target_status: WorkItemStatus) → WorkItem
addComment(item_id: string, body: string) → comment_id: string
search(query: WorkItemQuery) → WorkItem[]
```

### 类型

```yaml
WorkItemStatus: OPEN | IN_PROGRESS | DONE | BLOCKED
WorkItemCategory: FEATURE | BUG | TASK | REQUIREMENT
WorkItemPriority: CRITICAL | HIGH | MEDIUM | LOW

WorkItemCreate:
  title: string
  description: string
  category: WorkItemCategory
  priority: WorkItemPriority
  labels: string[]

WorkItem:
  id: string
  title: string
  description: string
  status: WorkItemStatus
  category: WorkItemCategory
  priority: WorkItemPriority
  labels: string[]
  created_at: string        # ISO 8601
  updated_at: string        # ISO 8601
  url?: string
```

### 状态转换

```
OPEN → IN_PROGRESS
IN_PROGRESS → DONE
IN_PROGRESS → BLOCKED
BLOCKED → IN_PROGRESS
```

### 合约

1. 所有方法必须处理网络错误，带重试（最多 3 次，指数退避）
2. 认证错误必须立即失败，附带清晰消息
3. `create` 如果外部系统不提供 ID，必须生成唯一 ID
4. `transition` 必须在执行前验证状态转换合法性
5. `search` 无过滤条件时返回最近更新的条目
6. 适配器不得修改仓库状态
7. 速率限制必须透明处理（等待并重试）

---

## 2. CI Adapter

抽象 CI/CD 系统（GitHub Actions, GitLab CI, Jenkins, 空操作）。

### 接口方法

```yaml
trigger(pipeline_name: string, parameters: dict) → run_id: string
waitForCompletion(run_id: string, timeout_seconds: int = 600) → CIStatus
getStatus(run_id: string) → CIStatus
getLogs(run_id: string) → string
```

### 类型

```yaml
CIStatus: SUCCESS | FAILURE | CANCELLED | TIMEOUT | RUNNING | UNKNOWN
```

### 合约

1. 所有方法必须是幂等的 — 用相同参数调用 `trigger` 应创建新运行（不报错）
2. `waitForCompletion` 不得修改运行状态
3. `getLogs` 在日志不可用时可以返回空字符串
4. 适配器不得修改仓库状态
5. 网络错误：指数退避重试（最多 3 次）
6. 超时：返回 TIMEOUT 状态，不抛异常

---

## 3. Executor Adapter

抽象 AI Agent 运行时（子 Agent、Claude Goal、Codex Task、Shell）。

### 接口方法

```yaml
dispatch(task: TaskSpec) → task_id: string
waitForResult(task_id: string, timeout_minutes: int = 30) → TaskResult
cancel(task_id: string) → bool
isAvailable() → bool
```

### 类型

```yaml
TaskSpec:
  taskId: string
  role: string             # explorer | worker | tester | reviewer
  objective: string
  scope:
    allowedRepos: string[]
    allowedFiles: string[]
    allowedCommands: string[]
  forbiddenSideEffects: string[]
  context: string          # 完整上下文文本（非文件引用）
  evidenceDir: string
  timeoutMinutes: int

TaskResult:
  verdict: PASS | PASS_WITH_CONCERNS | NEEDS_CONTEXT | FAIL | BLOCKED
  summary: string
  findings: string[]
  changedFiles: string[]
  commandsRun: string[]
  evidence: string[]
  risksOrBlockers: string[]
```

### 合约

1. 执行器不得修改声明范围外的任何文件
2. 执行器不得创建额外 agent（depth > 2 禁止）
3. 执行器不得编辑 master/main 分支
4. 执行器不得触发 CI 流水线
5. 执行器必须将证据保存到指定的 `evidenceDir`
6. 执行器必须在返回前写入 `result.json` 到证据目录
7. 如果运行时不可用，`isAvailable()` 必须返回 false（不抛异常）
8. `dispatch` 必须立即返回（非阻塞）；使用 `waitForResult` 收集结果

---

## 适配器配置

所有适配器从 `project.yaml` → `adapters` 读取配置：

```yaml
adapters:
  work_item:
    type: "github-issues"
    config:
      repo: "my-org/my-repo"
      token_env: "GITHUB_TOKEN"
  ci:
    type: "github-actions"
    config:
      repo: "my-org/my-repo"
      token_env: "GITHUB_TOKEN"
      workflow_file: "ci.yml"
  executor:
    type: "sub-agent"
    # sub-agent 不需要额外配置
```

---

## 实现指南

每个 adapter 实现必须：
1. 实现接口的所有方法
2. 在类的 docstring 中声明配置依赖
3. 提供 `isAvailable()` 方法用于启动检查
4. 处理所有错误情况（网络、认证、超时、速率限制）
5. 将错误转换为标准化的异常类型
6. 不修改仓库状态（除非显式允许）