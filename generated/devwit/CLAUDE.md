# DevWit — 简洁上下文 AI 原生桌面 IDE — AGENT OPERATING INSTRUCTIONS

你是这个项目的执行 agent。本项目由 meta-harness 生成，harness 配置在当前目录。

## 启动前

1. 读 `task.yaml` —— 项目目标、domain、acceptance_criteria、hard_constraints
2. 读 `harness-scaffold.yaml` —— harness 结构 manifest（哪些 slot 已填充、哪些待填）
3. 读 `memory/session-state.yaml` —— 当前阶段、acceptance_criteria 进度

## 工作流

- 每个 work unit 从 `planning/work-units.yaml` 派发，由 `planning/dispatcher.py` 实例化 task card
- 每个 work unit 完成后跑 `python verification/self-check.py --verify-ac <task_id>` 校验
- 推进 phase 前跑 `python verification/hook-executor.py --event pre_advance_phase ...` 校验 gate
- 任何控制指令/状态变更必须经 `verification/audit-append.py` 写 audit_log（不可篡改）

## 硬约束（来自 task.yaml）

- 不得 mock/fake/stub 真实集成
- 不得绕过 audit_log
- 每条 acceptance_criteria 必须有可验证证据
- 配置支持热更新（不重启）

## Multi-Worktree Runtime（v2.6+）

本项目 scope=4（>=3），supervisor 已启用。多 worktree 并发调度：

### 启动 supervisor
```bash
# 单 session 模式（不调 supervisor，直接 orchestrator）
python orchestrator.py --next

# 多 worktree 模式（supervisor 调度多 workitem）
python runtime/supervisor.py run --project-root .

# 查看状态
python runtime/supervisor.py status --project-root .

# 优雅停止（写 STOP 文件，下轮停）
python runtime/supervisor.py stop --project-root .
```

### workitem source
workitem source adapter 在 `runtime/sources/<adapter>_source.py`（由 LLM 在 GENERATE 合成）。
配置在 `planning/workitem-source.yaml`。修改 source 不需重启 supervisor（热更新）。

### 合并策略
`planning/merge-policy.yaml` 决定合并策略：
- `rebase_only`（criticality>=4 默认）：workitem 分支 rebase 到 base，冲突标 blocked 转人工
- `merge_allowed`：需在 sub-agent-dispatch.yaml 加 merge-coordinator prototype

### 事件流（真相源）
所有 runtime 事件写 `.meta-harness/events/events.jsonl`（append-only + 哈希链）。
任何状态可从 events 重放重建。
```bash
python runtime/event_stream.py tail --project-root . --n 10
python runtime/event_stream.py verify --project-root .
```

## 完成判定

`python orchestrator.py --verify` 返回 PASS = 所有 acceptance_criteria 已验证完成。
