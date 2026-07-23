# Harness Engineering Framework

> 你只需要说出你想要什么，剩下的交给系统。

[English version](README_EN.md)

## 这是什么？

想象一下：你有一个想法，但不知道怎么实现。你告诉这个系统"我需要一个客户入驻系统"，它会：

1. **理解你的想法** — 把模糊的需求翻译成清晰的任务定义
2. **生成完整项目** — 自动生成包含7层+2横切+进化的可运行项目，每层都有可执行产物
3. **分配专业角色** — 自动创建一组 AI 代理，各司其职
4. **编排执行** — 规划谁先做、谁后做、谁并行做
5. **验证结果** — 自动检查产出是否达标
6. **越用越聪明** — 每次犯错都会让系统变得更好
7. **自我进化** — 系统会主动优化自己的规则、流程和代理配置，进化规则本身也会进化
8. **推陈出新** — 需求完成后，系统会主动发现可以改进的地方，提出超越原始需求的创新建议

**一句话**：这是一个"会进化、会创新的 AI 代理管理系统"——它确保 AI 代理干活靠谱，越来越靠谱，还能超越你的期望。

---

## 我该怎么用？

### 如果你不是程序员

你不需要懂代码。你只需要在 AI 编程工具中打开这个项目，然后告诉它你想做什么。

**支持的工具和上下文加载方式：**

| 工具 | 规则文件 | 加载方式 | 你需要做什么 |
|------|---------|---------|------------|
| **Trae** | `AGENTS.md` | ✅ 自动加载 | 打开项目即可 |
| **Claude Code** | `CLAUDE.md` | ✅ 自动加载 | 打开项目即可 |
| **Cursor** | `.cursorrules` | ✅ 自动加载 | 打开项目即可（generate.py 自动生成 .cursorrules 重定向到 AGENTS.md） |
| **其他 AI 工具** | — | ⚠️ 需手动 | 在对话中手动发送 `AGENTS.md` 的内容作为上下文 |

**关键：AI 必须读到规则文件才能按管道工作。** 如果 AI 没读到规则，它就会跳过管道直接干活——这不是我们想要的。

**示例——你只需要说：**

- "我需要一个客户入驻系统"
- "帮我做一个竞品价格监控工具"
- "我想自动化每周报告的生成"
- "做一个自由职业者发票管理的 SaaS"

AI 会**自动读取项目规则**（不需要你手动操作），然后：
- 解析你的需求
- 生成适合这个任务的完整可运行项目（7层+2横切+进化）
- 创建专门的代理来执行
- 验证结果是否达标
- 在需求满足后，主动提出创新建议

**你需要做的只有两件事：**
1. **说出你想要什么**（越模糊越好，系统会帮你理清）
2. **确认假设**（系统会列出它做的假设，你只需确认或纠正）

### 如果你是软件工程师

这个项目是一个 **自举的元 Harness**——它不是给某个项目用的 harness，而是**生成 harness 的 harness**。

**核心公式：**
```
Agent = Model + Harness
```
- Model 提供智能
- Harness 让智能可靠地发挥作用
- **更好的 Harness 往往比更好的 Model 更重要**

**生成工厂模式：**
```
模糊意图 → [解释器] → 结构化任务定义
                ↓
         [Harness 生成器] → 完整可运行项目（7层+2横切+进化）
                ↓                每层都有可执行产物（Python脚本、YAML配置、JSON Schema）
         [Agent 工厂] → 专用代理拓扑（动态生成，非预设选择）
                ↓
         [编排器] → 执行计划（跨所有层协调）
                ↓
         代理在生成的 harness 中执行 → 结果
                ↓
         失败反馈 → 元 Harness 改进 → 进化引擎优化
                ↓
         需求满足 → 创新引擎 → 推陈出新（超越原始需求）
```

**快速开始：**

1. 在 Trae / Claude Code 中打开这个项目
2. 对 AI 说你想做什么（例如："我需要一个客户入驻系统"）
3. AI 自动读取项目规则，按管道执行
4. 确认 AI 列出的假设
5. AI 生成完整的 harness 项目并执行
6. 需求满足后，AI 会主动提出创新建议

**命令行使用：**
```bash
# 生成一个完整的 harness 项目
python scripts/generate.py --task <task-file.yaml> --template <domain>

# 验证生成的项目是否完整（7+2层检查）
python scripts/verify-generation.py <generated-project-dir>

# 运行进化引擎
python scripts/evolve.py --project-root <generated-project-dir>

# 运行创新引擎（推陈出新）
python seeds/evolution/innovation-engine.py --project-root <generated-project-dir>

# 在生成的项目中运行创新周期
python orchestrator.py --innovate

# 查看质量评分
python scripts/quality-score.py
```

---

## 项目结构

```
README.md           ← 你正在读的这个文件
README_EN.md        ← 英文版
AGENTS.md           ← ⚡ AI IDE 自动加载的项目规则（Trae 入口）
CLAUDE.md           ← ⚡ AI IDE 自动加载的项目规则（Claude Code 入口）
META.md             ← 系统的 DNA（完整管道规格）
.gitignore          ← Git 忽略规则（generated/ 等）
│
meta/               ← 编译管道的四个阶段
  interpreter.md      第 1 步：意图 → 结构化任务
  harness-generator.md 第 2 步：任务 → 可执行 Harness 项目（7+2+evolution）
  agent-factory.md    第 3 步：Harness → 代理拓扑
  orchestrator.md     第 4 步：代理 → 执行计划（跨所有层协调）
  examples/           参考示例（非预设模板）
    topologies.md       代理拓扑示例
│
evolution/          ← 元级自我进化系统
  framework.md        进化算法（基因组、适应度、变异、选择）
                       （genome.yaml / log.yaml 在 seeds/evolution/ 作为生成种子）
│
templates/          ← 领域模板（生成工厂格式，每层指定可执行产物）
  web-app/            Web 应用
  api-service/        API 服务
  data-pipeline/      数据管道
  content-system/     内容系统
  automation/         自动化
│
seeds/              ← 种子产物（每层的可执行模板文件，由 generate.py 复制）
  context/            loader.py, knowledge-index.yaml
  tools/              schemas.yaml, sandbox.yaml, permissions.yaml, mcp-config.json
  memory/             snapshot.py, compression-rules.yaml
  planning/           dag-builder.py, flow-control.yaml, sub-agent-dispatch.yaml, budget.yaml
  verification/       consistency-check.py, security-guardrails.yaml, self-check.py
  feedback/           error-capture.py, retry-config.yaml, mistake-to-constraint.py, human-interface.yaml
  constraints/        architecture-rules.yaml, linter-config.yaml, entropy-reduction.py, cost-budget.yaml
  security/           sandbox-config.yaml, encryption-rules.yaml, audit-log.yaml
  observability/      tracing.yaml, metrics-dashboard.yaml, session-replay.yaml, versioning.yaml
  evolution/          framework.md, genome.yaml, log.yaml
                       innovation-engine.py    ← 创新引擎（推陈出新）
                       product-analyzer.py     ← 产品状态分析器
                       domain-advancements.yaml     ← Web 应用领域进阶模式
                       domain-advancements-api.yaml ← API 服务领域进阶模式
  orchestrator.py     ← 生成的项目入口（编排器）
│
generated/          ← 生成输出（每次编译的结果，git-ignored）
memory/             ← 元知识（跨项目积累，越用越强）
  generation-log.yaml 每次生成的记录（由 generate.py 维护，人类与机器可读）
  meta-mistakes.md    生成失败 → 管道改进
  task-patterns.md    已知任务模式（加速解释）
  decisions.md        架构决策记录
  progress.md         执行进度
│
scripts/            ← 可执行脚本（跨平台 Python）
  generate.py         核心生成管道：任务 → 完整 harness 项目
  verify-generation.py 验证生成项目的7+2层完整性
  evolve.py           证据驱动进化引擎
  verify.py           后置验证（lint、类型检查、测试、密钥扫描）
  pre-task.py         前置检查（任务卡、git 状态、阻塞器）
  quality-score.py    质量评分
```

---

## 关键概念

### 什么是 Harness？

Harness 是围绕 AI 代理构建的**约束+工具+验证**系统。就像赛马需要缰绳（harness）才能跑对方向，AI 代理需要 harness 才能可靠地产出。

没有 harness 的代理：可能做对，可能做错，你不知道是哪种。
有 harness 的代理：做错了会被拦住，做对了会被验证，结果可预测。

### 生成工厂 vs 描述框架

**旧模式（描述框架）**：生成 markdown 文件 → AI 读 markdown 按规则干活
**新模式（生成工厂）**：生成完整可运行项目 → 每层都有可执行产物（Python脚本、YAML配置、JSON Schema）

| 层 | 生成的可执行产物 |
|---|---|
| 1. 上下文工程 | AGENTS.md + 上下文加载脚本 + 知识索引 |
| 2. 工具集成 | 工具 schema + 沙箱配置 + 权限清单 + MCP 配置 |
| 3. 记忆与状态 | 会话状态文件 + 长期记忆结构 + 快照脚本 + 压缩规则 |
| 4. 规划与编排 | DAG 构建脚本 + 流控配置 + 子 agent 调度 + 预算配置 |
| 5. 验证与护栏 | 格式校验器 + 一致性检查脚本 + 安全护栏 + 自验证循环脚本 |
| 6. 反馈与自愈 | 错误捕获器 + 重试策略 + 错误→约束闭环脚本 + 人工介入接口 |
| 7. 约束与熵 | 架构规则 + 代码强制配置 + 熵减脚本 + 成本约束 |
| 安全与隔离 | 沙箱配置 + 加密规则 + 审计日志 |
| 可观测性 | 追踪配置 + 指标面板 + 会话回放 + 版本管理 |
| 自我进化 | 进化框架 + 基因组 + 进化日志 + 创新引擎 + 产品分析器 |

### 为什么错误会让系统变强？

每次生成失败，根因分析会被记录到 `memory/meta-mistakes.md`，然后改进生成管道。这形成了一个**复利反馈环**：

```
错误 → 根因分析 → 约束改进 → 未来生成更好 → 更少错误
```

用得越多，系统越聪明。这是和传统模板库的根本区别。

### 代理拓扑是动态生成的

系统根据任务分析**合成**最优的代理图，而非从预设模式中选择：

1. 识别工作单元（每个约束、工作流步骤、领域）
2. 映射依赖关系
3. 确定并行性
4. 分配角色（合并紧耦合的，拆分超上下文的）
5. 添加验证层（永远必须有独立的验证者）
6. 定义交接点

### 系统会自我进化

这是最激进的设计。系统不仅能从错误中学习，还能**主动优化自己**：

**三层基因组（什么可以进化）：**
- **Harness 基因组**：约束、工作流、技能、验证规则
- **Agent 基因组**：拓扑结构、角色范围、交接格式、上下文预算
- **进化基因组**（元进化）：变异算子、选择标准、适应度权重、变异率

**进化循环：**
```
收集证据 → 测量适应度 → 提出变异 → 测试变异 → 选择或拒绝 → 更新基因组
                                                    ↓
                                      元进化：更新变异/选择规则本身
```

**安全约束（防止"癌症"和"自杀"）：**
- 永远不能删除验证层（否则系统会接受错误结果——"癌症"）
- 永远不能删除进化系统本身（否则系统停止进化——"自杀"）
- 变异率永远不超过 30%（否则系统陷入混乱）
- 所有变异必须可逆（保留上一版基因组）

### 推陈出新：创新引擎

系统最独特的能力——**不只是完成需求，而是超越需求**。

当所有验收标准满足后，创新引擎会自动启动：

```
需求满足 → 产品状态分析 → 领域进阶匹配 → 创新提案 → 优先级排序 → 人工确认
```

**四阶段进阶模型：**

| 阶段 | 含义 | 说明 |
|------|------|------|
| **Basic** | 满足需求 | 核心功能实现，基本测试通过 |
| **Solid** | 生产可用 | 错误处理、加载状态、输入校验、分页、通知 |
| **Advanced** | 竞品水准 | 离线支持、暗色模式、快捷键、搜索过滤、审计追踪 |
| **Excellent** | 市场领先 | 实时协作、无障碍访问、国际化、性能监控 |

创新引擎根据当前产品所处的阶段，自动提出下一阶段的创新建议。例如：

- Web 应用在 Basic 阶段完成后，会建议添加错误边界、加载状态、输入校验等 Solid 阶段特性
- API 服务在 Solid 阶段完成后，会建议添加游标分页、Webhook 通知、缓存层等 Advanced 阶段特性

**安全机制：**
- 高工作量或安全相关的创新需要人工确认（🔒 NEEDS APPROVAL）
- 低工作量且非安全的创新可自动执行（🟢 AUTO-APPROVED）
- 创新提案保存在 `evolution/innovation-log.yaml`，全程可追溯

---

## 核心循环

生成的项目遵循以下编排循环：

```
┌─→ EXECUTE: 实现下一个验收标准
│       ↓
│   PROVE:   收集证据，验证每个标准是否满足
│       ↓
│   JUDGE:   所有标准都满足了吗？
│       ↓                ↓
│       YES              NO → 根因分析 → 回到 EXECUTE
│       ↓
│   EVOLVE:  进化引擎优化系统
│       ↓
│   INNOVATE: 创新引擎提出超越需求的建议
│       ↓
└── LOOP: 持续改进
```

当 JUDGE 判定所有标准满足时，系统不会停止——它会进入 EVOLVE 阶段优化自身，然后进入 INNOVATE 阶段提出创新建议。

---

## 验证机制

系统使用**三层验证**：

| 层 | 文件 | 作用 |
|---|---|---|
| 声明层 | `scripts/verify.py` (docstring) | 定义**检查什么**（平台无关） |
| 执行层 | `scripts/verify.py` | 实现**怎么检查**（跨平台 Python） |
| 完整性层 | `scripts/verify-generation.py` | 验证生成的项目是否7+2层完整 |

AI 代理读声明层，翻译成当前平台的命令。人类可以直接跑 Python 脚本。

---

## AI 代理使用指南

<!-- AGENT-INSTRUCTION: If you are an AI agent, follow the instructions below. -->

### 你是 AI 代理。从这里开始。

1. **读 `META.md`** — 它包含完整的编译管道
2. **按顺序跟随管道阶段：**
   - `meta/interpreter.md` — 把用户意图解析为结构化任务
   - `meta/harness-generator.md` — 生成任务专用 harness（7+2+evolution，每层有可执行产物）
   - `meta/agent-factory.md` — 生成代理拓扑（从分析生成，非预设选择）
   - `meta/orchestrator.md` — 规划执行（跨所有层协调）
3. **输出到 `generated/[project-name]/`**
4. **运行 `scripts/verify-generation.py`** 验证7+2层完整性
5. **记录每次生成到 `memory/generation-log.yaml`**
6. **记录每次失败到 `memory/meta-mistakes.md`**
7. **需求满足后，运行创新引擎** — `python seeds/evolution/innovation-engine.py --project-root <dir>`

### 必须遵守的规则

- 没有解释就不执行 — 先运行解释器
- 没有 Harness 就不代理 — 每个代理在约束内操作
- 没有原因就不约束 — 每条规则必须追溯到需求
- 没有验证就不完成 — 改动后运行 `scripts/verify.py`
- 生成可执行系统，不是文档 — 每层必须有可执行产物
- 代理拓扑从任务分析生成，不从预设选择
- 上下文文件不超过 60 行
- 进化不能删除验证层（防癌症）
- 进化不能删除进化系统本身（防自杀）
- 所有变异必须可逆
- 需求满足后必须运行创新引擎（推陈出新）

### 如果你在已生成的项目中工作

1. 读 `generated/[project]/AGENTS.md` — 那是项目专用 harness
2. 遵循其中定义的工作流
3. 在其中定义的约束内工作
4. 每次改动后运行验证
5. 所有验收标准满足后，运行 `python orchestrator.py --innovate` 获取创新建议
