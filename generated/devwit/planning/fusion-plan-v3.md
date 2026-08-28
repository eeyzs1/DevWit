# DevWit 融合进化实施计划 — Fusion Plan v3 (work units)

> 状态：**COMPLETE**（2026-08-29 终验通过）
> 背景：meta-harness 已升级至 v3.0.0（DeepSeek Harness 理念：事件日志即真相源 / fail-closed
> 不变量 / 钩子 / 接缝 / 权限模型 v2 / 压缩+spill / postmortem / 进化加固）。
> 本计划把 v3.0 能力融合进 DevWit：**层面 A** 升级生成项目 harness 运行时（v2.6 → v3.0 形态），
> **层面 B** 融合 DSH 产品架构到 IDE 本体。两层面文件集互不重叠 → 并行执行。

## 完成状态

- 层面 A：A-WU1 事件日志统一 ✅ / A-WU2 事件分发+bail ✅ / A-WU3 seams ✅ / A-WU4 composition+patch ✅ /
  A-WU5 skills 目录 ✅ / A-WU6 权限 v2 ✅ / A-WU7 goal+compaction+spill ✅ / A-WU8 postmortem+回归 ✅
- 层面 B：B-WU1 会话日志即真相源 ✅ / B-WU2 agent loop 事件化 ✅ / B-WU3 授权 fail-closed+seams ✅ /
  B-WU4 系统提示段注册表 ✅ / B-WU5 模式插件化 ✅ / B-WU6 AgentBackend seam ✅
- 终验：全量单测 793+ 通过 / tsc -b 全绿 / 事件日志不变量 PASS / orchestrator --verify 全过
- 提交：generated/devwit 14 个提交（355b530 → bf5aa80）+ root 1 个（9ca5a6b）

## 0. 执行原则（所有 work unit 必须遵守）

- P1 保持现状全绿：766 单测、构建（tsc -b + esbuild）、现有 e2e 不得回归；每项改动跑对应测试。
- P2 每项有可验证证据：单测 / e2e / `verification/self-check.py --verify-ac` / 新增 gate 脚本。
- P3 向后兼容：既有接口（LLMProvider / ModeDefinition / AgentRunInput / IPC 白名单）不破坏；
  新机制以"新增 + 迁移"落地，不重写即删。
- P4 真实性：不 mock 集成；事件日志、权限、接缝均为真实调用。
- P5 审计：所有状态变更走事件日志（v3.0 语义），禁止手改派生投影。

## 1. 层面 A — 生成项目 harness 运行时升级（v2.6 → v3.0 形态）

作用域：`runtime/`、`planning/`、`verification/`、`skills/`、`memory/`、`orchestrator.py`、根 AGENTS.md。
与层面 B（`packages/*`、`apps/desktop/*`）文件集无交集。

### A-WU1 事件日志统一（P0）
- 现状：`runtime/event_stream.py` 写 `.meta-harness/events/events.jsonl`（append-only + 哈希链），
  `memory/session-state.yaml` 是独立状态。
- 动作：移植 v3.0 `state_fold.py`（append-only `memory/event-log.yaml` + CAS + fold 投影）与
  `log_invariant.py`（fail-closed：未知版本/事件类型、seq 空洞、过期 watermark、孤儿 compaction）；
  将现有 events.jsonl + session-state.yaml 以 `seed/import` 迁移进新日志；`session-state.yaml`
  与 `.meta-harness/PHASE_BRIEF.md` 变为派生投影（asOfSeq watermark）。
- 证据：迁移后 `--check-invariants` PASS；重放投影 == 旧状态（7 AC 全 VERIFIED）；哈希链校验通过。

### A-WU2 不变量接入自检（P0）
- 动作：`verification/self-check.py` 增加 invariant gate（调用 log_invariant）；`hook-executor.py`
  事件对齐 v3.0（emit/serial/bail/parallel/waterfall 助手）。
- 证据：`self-check.py --verify-ac` 全过；注入 seq 空洞/未知类型 → gate FAIL（fail-closed）。

### A-WU3 能力接缝 seams（P1）
- 现状：`runtime/sources/`（workitem-source 适配器）、`planning/workitem-source.yaml`。
- 动作：新增 `seams/{workitem-source,executor,ci,sandbox}/definition.yaml`（定义/提供者/消费者）；
  将 `workitem-source.yaml` 声明为 seam 实例；validate-harness check [11]：拒绝 PARTIAL seams 与
  配置了但缺失的适配器。
- 证据：`scripts/validate-harness.py` 对 seams 全通过；故意删一个 adapter → check [11] 拒绝。

### A-WU4 组合清单 + 补丁（P1）
- 现状：`harness-scaffold.yaml` + `harness-profile.yaml`。
- 动作：新增 `harness-composition.yaml`（命名行）+ `harness-patch.yaml`（按 id 覆盖，未知 id 拒绝），
  `scripts/compose.py` 合并；orchestrator `--verify` 只跑 `runner=orchestrator` 启用的行。
- 证据：compose 合并结果与预期一致；未知 id → 拒绝（回归测试）。

### A-WU5 技能目录（P1）
- 现状：`skills/*.md`（11 个 markdown，无目录）。
- 动作：新增 `skills/catalog.yaml`；`seeds/context/loader.py skill list|load` 支持目录、列出损坏技能及原因。
- 证据：`loader.py skill list` 输出 11 项；人为损坏一项 → 列出原因。

### A-WU6 权限模型 v2（P2）
- 现状：`tools/permissions.yaml`（v1）。
- 动作：升级 v2（显式 modes：read-only / workspace-write / full + presets）；
  `tools/enforce-permission.py` 区分"sandbox 拒绝"(exit 126) 与"任务失败"(runner exit)；
  `guard.py --permission` 单调链（denial final）。
- 证据：权限矩阵单测；126 语义 e2e。

### A-WU7 钩子 + goal 语义 + 压缩/spill（P2）
- 动作：`hooks/pre-advance/*.py`（bail gate，非零拒绝 + phase/refused 记录，同码 3× → blocked）；
  orchestrator `rounds/max_rounds`、`--unblock --code --reason`、`--pause/--resume`；
  `--compact`（lock 标记 + 孤儿检测）+ `scripts/spill.py`（大文本落盘 + 定位器）。
- 证据：hook 拒绝场景单测；rounds 上限生效；compact 无孤儿。

### A-WU8 postmortem + 回归测试（P2）
- 动作：`memory/postmortems/NNNN-<slug>.md` + `mistake-to-constraint.py` 幂等写入（what/root cause/why escaped/lesson）；
  为 A-WU1..7 每个 gate 配回归测试（镜像 meta_harness `tests/`）。
- 证据：postmortem 写入幂等；`python -m pytest tests/` 全过。

## 2. 层面 B — 产品架构融合（DSH → DevWit IDE）

作用域：`packages/agent-runtime`、`packages/context-engine`、`packages/contracts`、
`packages/llm-providers`、`apps/desktop/src/main`。与层面 A 文件集无交集。

### B-WU1 会话日志 = 唯一真相源（P0，产品差异化核心）
- 现状：`agent-runtime/src/trace.ts`（AgentTrace）+ `apps/desktop/src/main/ai-runtime.ts` 维护
  会话历史；`historyFromTrace` 重建 role=tool 消息。
- 动作：新增 append-only SessionEvent 日志（会话内事件：user/message、assistant/*、tool/*、
  approval/*），`deriveMessages()` 从日志派生模型历史；AgentTrace 变为日志的投影；
  **运行时不变量：模型可见 ⟺ 已入日志**（断言 + 测试）；保留 usage 汇总（真实计费量）。
- 证据：历史重建 == 旧实现输出（既有 orchestrator/chat-controller 测试全绿）；
  不变量断言触发即失败；回放/续聊/审计从日志派生。

### B-WU2 Agent loop 事件化（P1）
- 现状：`agent-runtime/src/agent-loop.ts` 命令式循环（346 行，deps 注入）。
- 动作：turn/step 生命周期 + 事件瀑布扩展点（agent/pre-step、agent/request、llm/stream、
  tools/pre-execute|execute|post-execute、agent/turn-stopping）；瀑布监听者调 `next()` 委托；
  modes/MCP 动态工具/诊断闭环改挂事件；保留 AgentLoopDeps 兼容层或显式迁移。
- 证据：既有 agent 行为等价（agent-loop 测试全绿）；新增拦截器单测（改写消息/拒绝 step/停 turn）。

### B-WU3 Capability seams + 权限 fail-closed（P1）
- 现状：`llm-providers` createProvider 工厂；`agent-runtime/src/authorizer.ts`。
- 动作：shell/fs/subagent/approval 各一个 seam（Service Definition / Provider / Consumer）；
  ApprovalOutcome = allowed-once | rejected | cancelled | unavailable，**unavailable 也关门**；
  audit 事件（approval/asked、approval/decided）只入日志不进模型上下文。
- 证据：seam 换实现不换消费者（单测）；fail-closed 矩阵单测；IPC 授权弹窗行为不变。

### B-WU4 系统提示注册表组装（P2）
- 现状：`context-engine` 每轮 build manifest。
- 动作：PromptSection（name/order/text 或逐次求值函数）+ 每轮瀑布组装；`FIRST_PARTY_SECTION_ORDER`
  命名段位；manifest 审计保留（AC2 不回归）。
- 证据：manifest 输出兼容；新增 section 热注册即生效（单测）。

### B-WU5 模式系统插件化（P2）
- 现状：modes JSON 配置 + 热更新。
- 动作：per-mode scoped 注册空间（模式隔离）；模式可挂服务/事件/上下文 section；热更新保留。
- 证据：两模式并行注册互不泄漏（单测）；热更新即时生效（既有 e2e）。

### B-WU6 agent-backend seam（后续，依赖 B-WU2/B-WU3）
- 动作：定义 `AgentBackend` seam；`claude-agent-sdk` / `@openai/codex` 作为可选 provider
  （子进程 + 事件映射到 AgentTrace），默认仍是自研 loop。
- 证据：backend 切换单测 + 可选依赖未装时优雅降级。

## 3. 并行执行拓扑

```
        FUSION-V3
       ┌─────────┐
       │ 计划文档 │
       └────┬────┘
      ┌─────┴──────┐
  层面A          层面B
  A-WU1 (P0)     B-WU1 (P0)
    │              │
  A-WU2 (P0)     B-WU2 (P1)
    │              │
  A-WU3 ─ A-WU4   B-WU3
    │              │
  A-WU5 ─ A-WU6   B-WU4 ─ B-WU5
    │              │
  A-WU7 ─ A-WU8   B-WU6 (依赖 B2/B3)
```

- A/B 各自串行为主，层内可并行的（A-WU3/A-WU4、A-WU5/A-WU6、B-WU4/B-WU5）分头执行。
- 每完成一个 WU：跑对应测试 + 记录证据到 `evidence/` + 追加事件日志条目。

## 4. 风险与护栏

- 会话日志重构（B-WU1）触及 chat 历史/IPC：先加"新旧双写对比"测试再切换，避免 400（tool_calls
  无配对）历史问题回归。
- 事件日志迁移（A-WU1）保留旧 events.jsonl 直到校验通过再归档。
- 层面 B 所有 IPC/白名单/UI 契约不变，纯内部重构，e2e 全量兜底。
- 验收：`python orchestrator.py --verify`（生成的 runtime）+ 根管线 `--check-invariants` 均 PASS。
