# Capability Seams — DevWit 产品侧（Fusion Plan v3 — B-WU3）

借鉴 DeepSeek Harness 的 capability-seam 模型：每个可替换能力是**三件套**
（Service Definition / Provider / Consumer），一个角色单独不构成 seam。
换 provider 是装配变更，不是消费者修改。

| Seam | Definition（接口契约） | Provider（实现） | Consumer（只经接口调用） |
|---|---|---|---|
| **approval**（授权门） | `packages/agent-runtime/src/authorizer.ts`：`Authorizer` + `AuthorizationHandler`；闭集 `AuthorizationOutcome`（allow/allow_session/deny/**cancelled/unavailable**），`isAuthorizationGranted` fail-closed | 交互裁决：apps 层 IPC 弹窗（`apps/desktop/src/main/ipc.ts` `authorize` → renderer）；自动裁决：白名单 `AuthorizationMemory`（AC29） | `agent-loop.ts` `runOneTool`：`if (!isAuthorizationGranted(decision))` → 拒绝执行（deny/cancelled/unavailable 一律拒绝） |
| **shell**（命令执行） | `packages/agent-runtime/src/tools.ts`：`executeTool` + `ToolEnvironment` 契约 | 本地 shell：`shell.ts`（node-pty/child_process）；apps 注入 workspace/terminal 实现 | agent-loop 工具循环（bash 工具）；terminal 面板（apps/desktop） |
| **fs**（文件访问） | `packages/workspace` 文件服务 + `ToolEnvironment` 读接口 | 本地 fs（node:fs）；测试 `MemoryEnvironment` | read/write/edit 工具（tools.ts）、workspace 服务 |
| **subagent**（子代理） | `packages/agent-runtime/src/orchestrator.ts`：`AgentOrchestrator` 子任务契约（SubTask/plan/subagent_start/done） | 同进程编排（默认）；后续可挂 claude-agent-sdk / @openai/codex 外部 agent（B-WU6） | agent-loop 编排模式（AC20） |

## fail-closed 规则（approval seam）

- 只有 `allow` / `allow_session` 放行；`deny` / `cancelled` / `unavailable` 一律拒绝执行。
- `unavailable` = 没有可用 answerer（handler 缺失/抛错/非归属裁决）——拿不到裁决就不放行。
- 挂起请求取消（abort）按 `cancelled` 收尾（`cancelPending`），与用户拒绝 `deny` 区分但同样拒绝。
- 审计：`authorization_request` / `authorization_decision`（含 outcome）只入轨迹日志，不进模型上下文。

## 验证

- `packages/agent-runtime/tests/authorizer-failclosed.test.ts`：闭集判定 / handler 抛错→unavailable /
  cancelPending→cancelled / 未知 id 不裁决 / denyAllPending 兼容。
- `isFailureTraceEvent`（contracts）：deny/cancelled/unavailable 均视为失败轨迹事件。
- 全量单测 + `tsc -b` 全绿。
