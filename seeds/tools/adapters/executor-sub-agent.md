# Sub-Agent Executor Adapter

吸收自：union 框架 `adapters/executor/sub-agent/adapter.md`

使用宿主 IDE 的 sub-agent/Task 工具为每个 Phase 派发隔离的代理。

## Setup

```yaml
# project.yaml
adapters:
  executor:
    type: "sub-agent"
```

## 工作原理

1. 引擎从磁盘读取 Phase spec
2. 引擎通过宿主的 Task 工具派发子代理
3. 子代理接收完整 spec 内容，执行工作，写入 `result.json`
4. 引擎轮询 `result.json` 存在性检测完成

## 优势

- 最便携：支持任何具有子代理功能的 IDE（Claude Code, Codex, Cursor, Cline 等）
- 无需用户交互（无需粘贴步骤）
- 支持无依赖 Phase 的并行执行
- 每个子代理获得隔离的上下文

## Sub-Agent Prompt 模板

```
You are executing a phase of a Meta-Harness run.

Read the phase spec at {specPath}. Do the work described. Run all mandatory commands.
When done, write a result.json to {resultPath} with the following format:
{
  "verdict": "PASS"|"FAIL"|"BLOCKED",
  "summary": "...",
  "evidence": ["path/to/evidence"],
  "changedFiles": ["path/to/file"],
  "commandsRun": [{"command": "...", "exitCode": 0}]
}

Save all evidence (screenshots, logs, test reports) to {evidenceDir}.
Do NOT modify files outside the allowed repos: {repoPaths}.
```