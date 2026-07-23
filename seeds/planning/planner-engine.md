# Planner Engine — 规划引擎种子

吸收自：union 框架 `engine/planner.md`
用途：将用户需求转化为可被 Executor 直接执行的 Phase DAG

---

## 概述

Planner 是 Meta-Harness 的规划引擎。它接收用户的模糊需求，经过环境感知、需求澄清、侦察、深度思考、自适应分解，产出可被 Executor 直接执行的 Phase DAG。

---

## Stage 0: 环境感知

### 0.1 读取项目配置
```
读取 project.yaml → 获取 repos, adapters, roles, phases, branch, quality_gates
```

### 0.2 检测可用工具
- 检查可用的 MCP 工具（Context7, WebSearch, WebFetch 等）
- 检查可用的 skills
- 检查 adapter 可用性（work-item, ci, executor 的 isAvailable()）

### 0.3 预载记忆
- 扫描 `.meta-harness/memory/` 目录
- 读取相关 MEMORY.md 中的反馈/项目/用户记忆
- 记录到 `applied-memories.md`

### 0.4 声明运行命名空间
- 使用 `scripts/claim-run.sh` 原子创建 `.meta-harness/runs/<run-id>/` 目录
- 检查是否有活跃运行可续接
- 打印共存警告（同一工作树不能同时执行两个运行）

---

## Stage 1: 需求澄清

### 1.1 分类任务
```
greenfield | brownfield | bugfix | refactor | ui
```

### 1.2 绿场项目（无现有代码库）
逐类别检查清单，每批最多 4 个问题：
- 目标平台/界面（iOS, Android, Web, CLI, 多端）
- 技术栈/框架偏好
- 设计方向/美学
- 集成锚点（认证、数据库、支付、部署）
- 范围裁剪线
- 主要用例/受众
- 性能/规模约束
- 数据模型锚点

已有记忆或 prompt 覆盖的类别跳过。

### 1.3 棕场项目（有现有代码库）
0-2 个问题，仅针对真正的缺口：
- 范围裁剪线
- 兼容性边界
- 多条现有路径时的分叉选择

---

## Stage 2: 侦察（并行）

### 棕场
```bash
detect-stack.sh > context.md      # 技术栈、包管理器、构建/测试/lint 命令
summarize-repo.sh > repo-map.md   # 目录结构、关键模块、风险区域
```

### 绿场
```bash
detect-env.sh > context.md        # 环境信息、可用工具
```

输出 5 行摘要：技术栈、包管理器、构建命令、值得注意的模块、风险区域。

---

## Stage 3: 深度思考

### 3.1 风险分析（Top 3）
对每个风险：什么可能出错、可能性、应对措施。

### 3.2 非显而易见的依赖
哪些事情必须按特定顺序？哪些事情会阻塞其他工作？

### 3.3 最佳实践研究
- Context7：查询第三方 SDK 的最新文档
- WebSearch：查询当前共识模式
- 记忆命中：应用之前保存的 learnings

### 3.4 输出 THINKING.md
目标、约束、风险、依赖、待解决问题（已假设）、应用的记忆、依赖的工具/技能。

---

## Stage 4: 自适应分解

### 4.1 推导 Phase 数量
Phase 数量由任务本身决定，无固定范围：
- 2 phases：小改动（hardening 收尾）
- 3-4 phases：小特性、单界面改动
- 5-7 phases：典型特性
- 8-12 phases：大型特性、全栈绿场
- 13+ phases：重大迁移、多系统重写

### 4.2 Phase 质量检查
每个 Phase 必须：
1. **独立可验证**：能独立构建、类型检查、lint、测试
2. **交付一件连贯的事**：能用 5 个词描述（不含"和"）

### 4.3 Phase DAG 声明
```
phase-1: 基础 (无依赖)
phase-2: 核心机制 (依赖 phase-1)
phase-3: 集成 (依赖 phase-2)
phase-4: 状态与边界 (依赖 phase-3)
phase-5: 打磨与加固 (依赖 phase-4)
```
无依赖关系的 Phase 可并行执行。

### 4.4 Phase-技能映射
从 `project.yaml` → `phase_skills` 读取。默认映射：
| Phase | 技能 |
|-------|------|
| PLAN | brainstorming + writing-plans |
| IMPLEMENT | tdd + subagent-driven-dev (or executing-plans as fallback) |
| TEST | code-review + verification + systematic-debugging (on failure) |
| Post-audit | finishing-a-development-branch |
| Cross-phase | dispatching-parallel-agents |

---

## Stage 5: 写入 Phase Specs

### 5.1 文件结构
```
.meta-harness/runs/<run-id>/
  ROADMAP.md           # 完整计划
  STATE.md             # 实时进度
  THINKING.md          # 风险、依赖、记忆
  context.md           # 侦察输出
  repo-map.md          # 棕场仓库地图
  applied-memories.md  # 应用的记忆
  phases/
    phase-1/
      spec.md          # Phase 规格（目标、验收标准、命令）
      result.json      # 执行结果（执行后写入）
      evidence/        # 截图、日志、测试报告
    phase-2/
      ...
```

### 5.2 Phase Spec 格式
每个 spec.md 必须包含：PHASE_START 标记、Work Description、Acceptance Criteria、Deliverables、Mandatory Commands、Evidence Required、Skills。

---

## Stage 6: 计划评审

### 6.1 自我批判
展示给用户前，运行一次自我批判：
- 1-3 个发现（标准的可证伪性、Phase 原子性、最弱依赖）
- 可证伪性问题在原位重写

### 6.2 展示计划
- 列出假设、风险、应用的记忆
- 展示每个 Phase 的摘要
- 提供修改菜单：Start now / Adjust assumption / Tweak a phase / Restructure phases

### 6.3 预飞行检查
运行去重后的强制命令一次（build + typecheck + lint + test）：
- `PREFLIGHT_GREEN` → 进入 Stage 7
- `PREFLIGHT_RED` → 重新进入 Stage 6，提供"跳过预飞行"选项

---

## Stage 7: 交棒

### 7.1 捕获 Baseline
```
Baseline ref: git rev-parse HEAD
```
写入 STATE.md。后续审计和 cleanliness 检查都以此为准。

### 7.2 模板占位符替换
模板文件中的 `{{RUN_ROOT}}` 占位符在此阶段替换为实际路径。

### 7.3 输出执行命令
根据 executor adapter 类型，输出对应的启动命令：
- `claude-goal` → 输出 `/goal` 命令
- `codex-task` → 输出 `/task` 命令
- `sub-agent` → 引擎自动派发

### 7.4 人类关口
- 绿场：Stage 1 的澄清问题 + Stage 6 的计划评审
- 棕场：Stage 6 的计划评审
- 总计：最多 2 次人类交互