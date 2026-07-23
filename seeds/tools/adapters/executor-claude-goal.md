# Claude Code /goal Executor Adapter

吸收自：union 框架 `adapters/executor/claude-goal/adapter.md`

使用 Claude Code 内置的 `/goal` 命令作为执行运行时。

## Setup

```yaml
# project.yaml
adapters:
  executor:
    type: "claude-goal"
```

## 工作原理

1. 引擎将 Phase spec 写入 `.meta-harness/runs/<id>/phases/phase-N/spec.md`
2. 引擎为用户打印 `/goal` 命令，附带简短结束状态条件
3. 用户将 `/goal` 命令粘贴到 Claude Code
4. Agent 从磁盘读取 spec，执行工作，写入 `result.json`
5. 引擎通过 transcript 中的 `PHASE_DONE` 检测完成

## End-State Condition

```
Execute the phase spec at .meta-harness/runs/<id>/phases/phase-N/spec.md.
Read the spec, do the work, run mandatory commands, print PHASE_VERIFY
then PHASE_DONE. Follow the failure recovery protocol in PROTOCOL.md.
Done when PHASE_DONE appears in the transcript.
```

## 限制

- 需要用户粘贴 `/goal` 命令（slash 命令只能从用户输入触发）
- 除非使用连续循环协议，否则每个 Phase 一个 `/goal` 命令
- Agent 必须将 `result.json` 写入磁盘供引擎读取