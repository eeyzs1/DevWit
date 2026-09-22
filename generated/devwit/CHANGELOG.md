# Changelog

所有显著变更记录于此。格式基于 [Keep a Changelog](https://keepachangelog.com/)，
版本遵循 [语义化版本](https://semver.org/)。

## [0.7.13] — 2026-10-02

### Fixed
- **编辑器内核对抗性自查（E 系列 9 项）**——对抗性审查第二轮（编辑器视图
  + piece-table + undo 栈全文逐行追踪）发现并修复：
- **多光标词删除光标漂移**（E1）：Ctrl+Backspace/Ctrl+Delete 后光标落点位移
  用「低位光标个数」近似「低位实际删除长度」——词删除每光标删多字符时高位
  光标系统性偏右，之后打字落错位置。抽取纯函数 `multiCursorFinalOffsets`
  （edit-ops.ts，14 项单测锁定）统一四条删除路径；Ctrl+Delete 的 total
  快照陈旧问题（光标重叠时扫描越界）一并修复
- **重合光标不去重 → 打字重复插入**（E2）：退格删到边界/垂直移动越过折叠
  汇聚/undo 后 clamp 汇聚产生完全重合光标，每敲一键插两遍（"a"→"aa"）。
  编辑/移动/undo 后按 (anchor, active) 去重（VS Code 同语义）
- **空选区 Ctrl+X 误标脏 + 空 undo**（E3）：cut nothing 仍发空编辑，
  applyEdit 对 no-op 无守卫——version++ → 已保存文档现未保存标记、关闭误弹
  确认，且留空 undo 记录（Ctrl+Z 按了没反应）。document.applyEdit 开头
  no-op 直接返回 + Ctrl+X 仅非空选区才发编辑
- **Undo/Redo 后光标停错误列**（E4）：撤销只回滚文本不恢复选区——输入 "abc"
  后 Ctrl+Z 光标停在词中间而非输入起点。document 暴露 getLastUndoRedoChanges，
  视图按变更数与光标数配对恢复（多光标打字各回各点），否则主光标回撤销组
  首变更起点/重做组末变更终点
- **ArrowDown 进入延伸至文件尾的折叠区 → 光标落入隐藏行卡死**（E5）：跳过
  隐藏行越界后被 clamp 回隐藏末行——不可见且每按一次都被弹回。clamp 后
  仍隐藏则回退最近可见行（VS Code 语义：停折叠头行）；ArrowRight 跨入
  隐藏行同样沿移动方向跳到最近可见行
- **IME 合成期间选区被移动/文档被替换 → 合成串插错位置**（E6）：合成开始
  记录锚点（选区+版本+文档引用），提交回落锚点；锚点失效（文档已换/已改）
  丢弃提交；setDocument 主动取消进行中的合成（防迟到 compositionend 插到
  新文档开头）
- **Backspace/Delete 拆散代理对**（E7）：按码元硬删 1 把 emoji 删成孤立
  高代理——乱码方块 + 保存时编码损坏。删除长度代理对感知（2 码元），
  纯函数 `backwardDeleteLength`/`forwardDeleteLength` 单测锁定
- **dispose 不回收 canvas 监听**（E8）：同一 canvas 重建 EditorView 时旧
  实例 mousedown/contextmenu 等仍存活（双份回调 + 无法 GC）——canvas 监听
  与 window 监听同模式收集并在 dispose 执行
- **onKeyDown 无 isComposing 守卫**（E10）：Firefox/Safari 合成期真实键名
  keydown 会打断候选窗导航（Chromium/Electron 不受影响，可复用包加固）

### Changed
- 渲染层测试基建：编辑运算纯函数抽至 `packages/editor-render/src/edit-ops.ts`
  并导出（multiCursorFinalOffsets / backwardDeleteLength / forwardDeleteLength）

## [0.7.12] — 2026-10-02

### Fixed
- **凭证损坏横幅无条件常显**（0.7.3 引入，对抗性自查发现）：横幅刷新读
  `settings.get` 未 await，同步判 `typeof Promise === "object"` 恒真——凭证
  完好也报「已损坏已备份」。改 async 读取后判定
- **replaceAll 后活动文件编辑器「哑掉」**：跨文件搜索全部替换重写活动文件
  换新 doc 后不重挂监听——脏状态回显、LSP 增量同步/自动补全/大纲全部停更
  （切标签重开才恢复）。抽取 `createWiredDoc` 统一装配，热替换后 LSP 全文
  重推 + 诊断/断点/大纲跟随
- **replaceAll 刷新期间切换标签可致写坏文件**（低概率高危）：刷新协程在
  `await read` 后不复验目标，把 A 文件内容装进当前活动文件 C 的条目，Ctrl+S
  即把 A 内容写入 C 的路径。改按 path 定位条目 + await 后复验仍存在才替换
- **删除使用中的模式/模型后 UI 与实际不同步**：删除对话面板当前选中的
  自定义模式后下拉显示第一个模式，但控制器仍持已删 id——下次发送报
  DW_MODE_NOT_FOUND 而界面看似有效。`refreshSelectors` 检测失效 id 回退
  首个模式（内置 Chat 恒在）/清空手动模型选择回跟随模式绑定
- **指挥台 diff 未关时切换形态成僵尸**：console 形态打开 diff 审查后切回
  chat，覆盖层留在隐藏容器且引用非空——再点「审查修改」被守卫静默吞掉。
  形态切换时覆盖层随迁（chat 挂编辑器区/console 挂 Diff 页签）；已占用时
  状态栏可见提示；console 关闭 diff 后回到代码页（不再停在空白 Diff 页）
- **保存/打开文件失败静默无反应**：Ctrl+S 写盘失败、点击 >50MB 或已被
  外部删除的文件节点，此前仅 unhandled rejection 零提示——现状态栏本地化
  报错（err.saveFailed / err.openFailed / err.treeFailed，中英词典）
- **设置页模式分区异步渲染竞态**：进入「模式」后其 `providers.list()` 未
  返回期间切到其它分区（或语言热切换），陈旧续跑把模式表单/社区段追加进
  新分区 UI。分区渲染代际守卫，过期即放弃
- **快速连点文件 A→B 竞态**：两次 read 竞速后完成者抢占活动标签——打开
  请求序号化，后发请求胜出
- **切换工作区残留 tsserver 旧文档**：enterWorkspace 清空标签不发
  didClose（switchToTab/closeFile 路径都发）——逐个补发；「打开文件夹」
  目录树加载失败由静默无反应改状态栏报错

### Changed
- 设置对话框单例守卫（按钮连点不再叠开多层）
- 设置页 4 处 catch 展示原始 error.message 改经 localizeError（providers/
  editor/modes/mcp 保存路径，DW_* 错误码与其余 6 处一致本地化）
- preload 缺失故障态文案走词典（原硬编码英文）
- verify-i19 第 2 轮请求体断言改等待式（pollUntil）——诊断行出现 ≠ 请求体
  已被本地端点接收，夜跑 9/18、9/21 失败 run 的 chat-bodies.json 仅 1 体
  实证为测试侧竞态；产品回归时 30s 超时仍失败，断言力不降级

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
