# Changelog

所有显著变更记录于此。格式基于 [Keep a Changelog](https://keepachangelog.com/)，
版本遵循 [语义化版本](https://semver.org/)。

## [0.7.11] — 2026-08-30

### Fixed
- **编排子 Agent 丢失角色提示**（v0.7.0 引入，非本系列回归）：Fusion B-WU4
  接线后 context-engine 在注册表存在时忽略 input.systemPrompt——子 Agent
  的 WORKER_PROMPT_SUFFIX 被共享注册表静默吞掉，自 v0.7.0 起一直以裸
  编排提示运行（无角色认知）。修复：input.systemPrompt 恒作为 mode 段
  文本覆盖（同值无操作，恢复 Fusion 前优先级语义）
  ——由不在 CI 的 verify-i11 扫尾发现（服务器分流日志实证 worker 锚点缺失）
- verify-i5 的设置按钮选择器过时（迭代 32 在 header 插入 blameBtn 后
  nth-5 变 blame，脚本静默失效）——修正为 nth-6

### Added
- **E2E 全量夜跑 CI**（nightly-e2e.yml + run-all.mjs 跑批器）：全部
  verify-iN 套件每晚回归，逐套汇总/单套超时看护/失败末尾输出定位——
  根治「不在 CI 的测试静默腐烂」（本轮元教训的制度化）
- winget 0.7.10 清单（SHA256 双源实证：GitHub API digest + 实际下载
  哈希一致）；verify-i11 失败时事件流/消息 DOM 诊断转储

## [0.7.10] — 2026-08-30

### Changed
- 渲染层 `el()` DOM 助手自五处本地拷贝收敛为共享 `dom.ts` 单一实现
- 新增本 CHANGELOG（产品级变更记录，自 0.7.1 起追溯补全）

## [0.7.9] — 2026-08-30

### Fixed
- **流式回复定稿丢失「审查修改」按钮**（0.7.3 引入）：增量渲染的 assistant
  快路径覆盖了 streaming 定稿时刻，含代码块的流式提案无法发起 diff 审查
  （脚本化 E2E 因 usage 事件插入走追加路径而对真实流式路径盲区）
- 流式自动滚动在新增高行（≥48px）时误判「不在底部」中断跟随——采样改到
  DOM 变更前
- 分支下拉外部点击监听器在 Escape/锚点二次点击/状态刷新路径残留泄漏

### Changed
- 长 agent 会话的取消传播监听器经 `setMaxListeners` 豁免（消除
  MaxListenersExceededWarning 噪音；累积受会话生命周期约束非无界）
- bash 命令归一化收敛单一实现（会话放行与持久白名单不再有漂移风险）
- 轨迹摘要缓存键补文件 size（同毫秒追加兜底）；正则 worker 补退出码兜底

## [0.7.8] — 2026-08-30

### Changed
- 渲染层模块化收尾：DAP 调试 UI 全集（断点体系/工具栏/调用栈/变量树/
  Watch 表达式/调试输出）抽取为 `debug-panel.ts`（index.ts 累计 −60%）

## [0.7.7] — 2026-08-30

### Changed
- 渲染层模块化第二步：Git 版本控制 UI 全集抽取为 `git-panel.ts`
  （面板/冲突解决/diff/blame/分支管理/徽章联动/git:changed 订阅随迁）

## [0.7.6] — 2026-08-30

### Changed
- 渲染层模块化第一步：跨文件搜索面板抽取为 `search-panel.ts`，
  LSP 代码智能全集（悬停/补全/引用/签名/重命名/代码操作/大纲）抽取为
  `lsp-ui.ts`；rename/codeAction 共用跨文件编辑逻辑去重为单一纯函数

## [0.7.5] — 2026-08-30

### Security
- **agent grep 的 ReDoS 隔离**：LLM 可控正则移入 worker 线程执行
  （常驻单 worker + 串行队列 + 每请求 10s 硬超时 + 空闲回收），
  灾难性回溯不再能挂死主进程

### Changed
- 会话轨迹摘要 mtime+size 缓存（列表刷新只重读变更文件）；
  多光标删词 getText 提升（O(文档×光标) → O(文档)）

## [0.7.4] — 2026-08-30

### Security
- **工作区搜索 ReDoS 修复**：搜索移入 worker 线程 + 10s 硬超时
  （主线程仅做正则合法性编译校验，保持同步 SyntaxError 语义）
- **allow_session 授权粒度收窄**：bash 从工具级放行收敛为命令级
  （归一化全串精确匹配）——「一次会话级批准 = 本会话任意命令」成为历史

### Changed
- chat 工具成败判定改以结构化 `result.ok` 为唯一事实源（不再按
  中文文案子串猜测；缺失保持未知）

## [0.7.3] — 2026-08-30

### Added
- **成本预算可选熔断**（enforce 开关，缺省关）：超限时拒绝新 agent run
  （DW_BUDGET_EXCEEDED，零 LLM 调用），设置页开关即改即存热生效

### Fixed
- **凭证损坏可见化**：凭据文件损坏（已备份为 .corrupt-*）不再静默清空
  全部 API Key——设置页告警横幅（中英双语），重录任一凭证后自动消除

### Changed
- **聊天面板增量渲染**：位置+引用+内容签名三元组对账，流式 delta 不再
  全量重建列表 DOM；底部跟随式自动滚动（用户上翻不被拽回）

## [0.7.2] — 2026-08-29

### Added
- **事务性 undo**：一次逻辑操作（多光标输入/多行缩进/注释切换）合并为
  一条 undo；多光标组跨击键逐位续写合并（坐标 frame 平移算法）；
  单光标打字合并语义零变化

### Changed
- **token 审计校准**：模型感知词典（GPT-4o+/o 系用 o200k_base）、工具定义
  紧凑 JSON 计数、manifest 新增 framingTokens/estimatedRequestTokens
  （组装帧开销与内容分开呈现）
- 会话列表扫描改行级预过滤摘要；内存会话表上限 32（LRU 淘汰，轨迹在盘
  可恢复）

## [0.7.1] — 2026-08-29

### Security
- **git_diff 免授权命令注入**（🔴）：LLM 可控 path 未校验拼入 shell 执行
  ——git_* 只读工具改 execFile 参数数组 + 路径白名单化
- **workspace symlink 逃逸**（🔴）：词法前缀比对升级为 fs.realpath 双防线
- **Electron 导航防护**：will-navigate 拒绝 + setWindowOpenHandler deny
- **MCP 供应链加固**：win32 shell 路径拒绝元字符参数；stdio 单行缓冲
  1MB 上限 fail-closed
- bash 工具 LLM 可控超时钳制 [1s, 10min]

### Added
- **CJK/全角/emoji 宽度正确渲染**：East Asian Wide 判定表 + 逐字符宽度
  模型，11 处坐标换算与文本绘制切换；纯 ASCII 行为零回归；
  新增 E2E 宽度实证（半角/全角=精确 2:1，点击回环全命中）

### Fixed
- 上下文单源失败放大为整轮请求失败——逐源降级为 manifest 可见占位；
  diff 接受后丢文件末尾换行；大文件渲染热路径 O(全文档)/帧 →
  可见行投影缓存 O(视口)

### Changed
- LLM/embed 请求 30s 连接阶段超时（长流不受限）；429/5xx 预流重试
  （尊重 Retry-After，退避可被取消打断）；社区索引拉取 10s 超时；
  上下文源并行收集

## [0.7.0] 及更早

见 [Releases](https://github.com/eeyzs1/DevWit/releases)。
