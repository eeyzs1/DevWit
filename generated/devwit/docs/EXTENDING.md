# DevWit 插件与扩展开发指南（EXTENDING）

> 版本：对应 Fusion v3 融合后的扩展面（2026-08）
> 本文回答：第三方开发者如何为 DevWit 增加能力，从零代码到代码级四个层级。

## 0. 扩展模型总览：四个层级

| 层级 | 方式 | 需要什么 | 适用对象 |
|---|---|---|---|
| **L1 配置级** | 自定义模式 + MCP 服务器（UI/设置页操作） | 无需写代码 | 任何用户 |
| **L2 发布级** | 社区模式仓库（`devwit-modes`）+ 任意 MCP server 发布 | 一个 JSON 模式文件 + Git 仓库 | 想分享"提示词/工具集配方"的开发者 |
| **L3 代码级** | 在 monorepo 内实现扩展接口（需构建） | TypeScript + 提交/PR | 想给 DevWit 本体加能力的开发者 |
| **L4 协议级** | MCP 协议服务器（任意语言实现） | 任意 MCP SDK | 想以独立服务形式提供工具的开发者 |

> 诚实边界（重要）：DevWit **目前没有运行时插件加载器**——L3 的扩展需要 fork 本仓库构建，不能在已装应用中动态加载一个 .js 插件；L4（MCP）与 L2（社区模式）才是真正的"热插拔"外部通道。若你需要运行时插件系统，那是一个架构决策（见 §6）。

---

## 1. L1：配置级扩展（零代码）

### 1.1 自定义模式
- 入口：设置页 → 模式管理 → 新建/编辑；也可导入模式文件（L2）。
- 模式定义（`ModeDefinition`，`packages/contracts/src/index.ts`）：`systemPrompt` + `tools` + `contextPolicy` + `providerId`。修改**热生效**（下次请求即用，无需重启）。
- 内置工具名列表（`tools` 字段可引用）：`read` `write` `edit` `bash` `grep` `find` `ls` `git_status` `git_diff` `git_log` `git_branch`。
- 上下文策略键（`contextPolicy`）：`system_prompt` `tool_definitions` `file_fragment` `git_status` `terminal_output` `selection` `conversation_history` `codebase_match` `diagnostics` `workflow` `custom`。

### 1.2 MCP 服务器
- 入口：设置页 → MCP 服务器；配置存 settings（`McpServerConfig`，见 `packages/contracts/src/index.ts`）。
- 两种 `transport`（缺省 `"stdio"`，向后兼容）：

  **stdio（本地子进程）**
  ```json
  {
    "id": "my-server",
    "name": "我的工具",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "my-mcp-server"],
    "env": { "API_TOKEN": "..." },
    "enabled": true
  }
  ```

  **http（远程 Streamable HTTP，revision 2026-07-28）**
  ```json
  {
    "id": "remote-server",
    "name": "云端工具",
    "transport": "http",
    "url": "https://mcp.example.com/mcp",
    "headers": { "X-Api-Key": "..." },
    "enabled": true
  }
  ```
  - http 为单端点 POST（`Accept: application/json, text/event-stream`），响应可为单个 JSON 或请求级 SSE 流；客户端自动发送 `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name`（非 ASCII 名 base64 哨兵）。
  - `headers` 为附加请求头（如 `Authorization: Bearer …`）。敏感凭据建议经凭证库引用：`auth: { "credentialRef": "<credentials id>" }`，运行时以 `Authorization: Bearer <token>` 注入。
  - stdio 与 http 共用同一工具暴露与授权路径：工具以 `mcp__<serverId>__<toolName>` 全名提供给 Agent，**所有 MCP 工具一律需授权**（默认最严）。
  - 配置热同步：增删/启停/换 URL 即刻反映到下一轮请求，无需重启（重启指纹含 transport/command/args/env/url/headers）。

---

## 2. L2：发布级——社区模式仓库（无需改 DevWit）

这是"分享模式"的官方通道：模式文件发布到一个公开 Git 仓库，应用经索引拉取。

### 2.1 模式文件格式（`ModeExportFile`，`packages/modes/src/mode-port.ts`）
```json
{
  "kind": "devwit-mode",
  "version": 1,
  "exportedAt": "2026-08-01T00:00:00.000Z",
  "mode": {
    "name": "我的模式",
    "description": "做什么",
    "systemPrompt": "你是……",
    "tools": ["read", "grep"],
    "providerId": "",
    "contextPolicy": { "codebase_match": true },
    "orchestrate": false
  }
}
```
规则（校验器 `parseExportFile` / `validateModeDefinition` 强制，全部失败抛 `DW_MODE_IMPORT_*`）：
- 信封必须带 `kind=devwit-mode`、`version=1`；旧/未知版本**明确拒绝**（不静默错读）。
- 导出剥离子机器字段：`id`/`builtin`/`createdAt`/`updatedAt` 由导入方重新生成（导入恒为自定义模式）。
- `providerId` 保留，导入时本机不存在该 provider 则清空为未绑定（跟随当前选中模型）。

### 2.2 发布流程
1. 建仓库（默认 `eeyzs1/devwit-modes` 风格）或任意公开仓库。
2. 放一个 `index.json`（`devwit-modes-index` kind，version 1）：
   ```json
   { "kind": "devwit-modes-index", "version": 1, "modes": [{ "id": "slug", "file": "modes/slug.json" }] }
   ```
   `file` 字段做防路径穿越校验（拒绝绝对路径与 `..`）。
3. 应用内：社区模式页 → 刷新/安装。base URL 可用环境变量 `DEVWIT_MODES_INDEX_URL` 覆盖（测试/私有源）。
4. 提交给官方索引只需一个 PR（仓库 `eeyzs1/devwit-modes`）。

---

## 3. L3：代码级扩展（monorepo 内，需构建）

以下接口全部在 `packages/` 内，接入点已在 `apps/desktop/src/main/ai-runtime.ts` 装配（Fusion v3）。

### 3.1 上下文源（ContextSource）
- 接口：`packages/contracts` → `ContextSource`（`type` + `collect(input)`）。
- 接线：`ai-runtime.ts` `registerSessionSources()` —— `engine.registerSource(source)`。
- 用途：给每次请求注入可审计的上下文项（文件片段/git 状态/RAG 块/诊断快照都是这么做的）。新源默认关闭，用户逐项开关（AC2 总闸语义）。

### 3.2 系统提示段（PromptSection，B-WU4）
- 接口：`packages/context-engine/src/prompt-sections.ts`：
  ```ts
  interface PromptSection {
    name: string;                       // 唯一，重复注册抛错
    order: number;                      // 升序拼接；段位分配见 FIRST_PARTY_SECTION_ORDER
    text: string | ((ctx) => string);   // 静态或按次求值
    complete?: boolean;                 // true = 成为唯一系统提示（>1 个冲突即失败）
  }
  ```
- 注册：`PromptSectionRegistry.register(section)`（返回注销函数，unwind）。
- 装配：`ai-runtime.run()` 每 run 前 `syncModeSections()` 重装（mode 提示基底段 + 模式作用域段）；段组成写进 manifest 的 `promptSections`（审计）。
- 用途：模式纪律、安全约束、工具使用规范等提示注入。

### 3.3 模式作用域注册空间（ModeScope，B-WU5）
- 接口：`packages/modes/src/mode-scope.ts` —— `ModeScopeRegistry`：
  ```ts
  scope.register(modeId, "prompt_section" | "tool" | "context_source", key, value)  // → 注销函数
  ```
- **隔离保证**：mode A 注册的条目在 mode B 下不可见；同 (modeId, kind, key) 重复注册抛错。
- 装配：`ai-runtime` 暴露 `runtime.modeScope`；`tool` 条目自动聚合进 agent-loop/编排的请求工具集（`modeScopeTools()`）。
- 用途：为某个具体模式挂专属工具/提示段/上下文源，不污染其他模式。

### 3.4 Agent 后端（AgentBackend，B-WU6）
- 接口：`packages/agent-runtime/src/agent-backend.ts`：
  ```ts
  interface AgentBackend {
    id: string;              // "internal" | "claude-agent-sdk" | "codex" | 自定义
    available: boolean;      // 缺二进制/凭据时为 false
    run(input: AgentBackendInput): Promise<AgentBackendResult>;
  }
  ```
- 注册：`runtime.registerAgentBackend(backend)`；选择：settings `agent.backendId`（缺省 internal）。
- 规则：配置的后端不存在/`available=false` → **自动回落 internal**（自研 loop，绝不静默失败）；外部后端事件需映射为 `AgentTraceEvent` 返回（入会话轨迹统一审计）。
- 用途：接入 Claude Code / Codex 等外部 agent 循环。

### 3.5 工具与 LLM Provider（更深的代码级）
- 内置工具：`packages/agent-runtime/src/tools.ts`（`executeTool` + `ToolEnvironment`）；写/执行类工具加入 `AUTHORIZED_TOOLS` 并配 `buildAuthorizationReason`。
- LLM Provider：`packages/llm-providers`（`ProviderFactory`：`anthropic` / `openai` 兼容实现，直连 HTTP+SSE，自定义 base URL/API key）。新协议 provider 在 `registry.ts` 注册工厂即可。

---

## 4. 端到端示例：给 "agent" 模式加一个专属工具 + 提示段

```ts
// 在 ai-runtime 装配后（或一个宿主插件模块里）：
const disposeTool = runtime.modeScope.register("agent", "tool", "my-helper", {
  name: "my_helper",
  description: "我的专属工具",
  parameters: { type: "object", properties: {}, required: [] },
});

const disposeSection = runtime.modeScope.register(
  "agent",
  "prompt_section",
  "discipline",
  "调用 my_helper 前必须先 read 目标文件",
);

// 下次 agent 模式请求：系统提示含该段（manifest 记录 mode-scope:discipline），
// 请求工具集含 my_helper（与 MCP 工具同层聚合）。
// 移除：disposeTool(); disposeSection();
```

对应的独立服务形态（L4，任何语言）：实现一个 MCP server，输出上述工具，设置页配一个 `McpServerConfig` 即可，无需碰 DevWit 源码。

---

## 5. 验证与发布清单

- L1/L2：应用内导入/安装 → 请求一次 → 检查「上下文面板 manifest」确认注入项与 token 占用（AC2 审计）。
- L3：`npm test`（全量 808+ 单测）+ `npm run build`（`tsc -b` + esbuild）；新增扩展必须带单测。
- 任何改动不得破坏：事件日志不变量（`python runtime/log_invariant.py --project-root .`）、`orchestrator.py --verify`。
- 发布：模式文件走 §2.2；代码级走 PR（附测试证据）。

## 6. 已知缺口（Roadmap）

- **运行时插件加载器**：目前无；L3 扩展需构建。若要做，建议形态：声明式 manifest + 受限沙箱 + IPC 白名单（可参考 harness 侧的 `seams/` 与权限 v2 模型）。
- **插件 SDK 包**：独立 npm 包（导出全部扩展接口 + 类型）尚未拆分。
- **IPC 开放面**：第三方代码访问渲染端/主进程的稳定 API 清单未成文。
- **MCP 高级特性（本期范围外）**：`resources`/`prompts` 面向模型暴露；legacy HTTP+SSE（2024-11-05）与旧 `Mcp-Session-Id` 会话的完整协商；SSE 进度（notifications/progress）在 UI 的展示；MRTR 采样/elicitation/roots 扩展。当前实现聚焦 `tools`，`transport` 已就绪。

---

## 附：关键文件索引

| 扩展面 | 接口/格式 | 文件 |
|---|---|---|
| 模式定义 | `ModeDefinition` | `packages/contracts/src/index.ts` |
| 模式文件 | `ModeExportFile` | `packages/modes/src/mode-port.ts` |
| 社区索引 | `CommunityModeEntry` / index | `packages/modes/src/community.ts` |
| 上下文源 | `ContextSource` | `packages/contracts/src/index.ts` |
| 提示段 | `PromptSectionRegistry` | `packages/context-engine/src/prompt-sections.ts` |
| 模式作用域 | `ModeScopeRegistry` | `packages/modes/src/mode-scope.ts` |
| Agent 后端 | `AgentBackend` / `BackendRegistry` | `packages/agent-runtime/src/agent-backend.ts` |
| 工具 | `executeTool` / `ToolEnvironment` | `packages/agent-runtime/src/tools.ts` |
| LLM Provider | `ProviderFactory` | `packages/llm-providers/src/registry.ts` |
| MCP | `McpServerConfig` | `packages/contracts/src/index.ts` |
| 装配点 | AiRuntime.run 各接线 | `apps/desktop/src/main/ai-runtime.ts` |
