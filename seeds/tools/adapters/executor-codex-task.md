# Codex Task Executor Adapter

吸收自：union 框架 `adapters/executor/codex-task/adapter.md`

使用 Codex CLI 的 `/task` 命令作为执行运行时。

## Setup

```yaml
# project.yaml
adapters:
  executor:
    type: "codex-task"
```

## 与 claude-goal 的区别

- Codex 的 `/task` 原生支持自动续接
- Codex 使用不同的 transcript 格式——引擎检测完成标记，不依赖宿主
- Codex 支持子代理生成，可用于并行 Phase 执行

## End-State Condition

```
Execute the phase spec at .meta-harness/runs/<id>/phases/phase-N/spec.md.
...
Done when PHASE_DONE appears in the transcript.
```