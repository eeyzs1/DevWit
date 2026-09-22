# Changelog

所有显著变更记录于此。格式基于 [Keep a Changelog](https://keepachangelog.com/)，
版本遵循 [语义化版本](https://semver.org/)。

## [0.7.27] — 2026-10-02

### Fixed
- **首启四模块对抗性审查修复（第八轮，9/10 项）**——onboarding-wizard /
  editor-setup-dialog / context-tour / auth-gate-tour（最后未覆盖的渲染面）：

**Major**
- **双层导览遮罩叠压**（R8-1，每次首启 100% 复现）：上下文导览显示后立即
  返回（不等待 dismiss），授权门导览马上叠上来——用户先看到错的那个 +
  双层半透明遮罩异常变暗。context-tour 返回 dismiss promise，调用方真正
  串行
- **向导上一步/下一步丢失全部输入**（R8-2）：baseUrl 重置回预设默认、
  API Key 清空、型号从不回填。输入提为闭包状态跨步骤保留（预设切换才
  重置）
- **语言选择视觉回跳**（R8-3）：改语言后下拉框显示回「跟随系统」（异步
  get 读到旧值覆写 select）。当前选择闭包记录，get 仅首帧校正

**Minor**
- **保存成功显示成红色错误样式**（R8-4）：新增 .dw-form-ok accent 样式
- **IPC 失败静默无反馈**（R8-5）：settings.set/完成标记补 catch（否则
  向导每次启动重弹）
- **upsert 失败留孤儿凭证密文**（R8-6）：补偿删除刚写入的 credentialRef
- **双击保存重复创建 provider**（R8-7）：按钮禁用去重
- **双击跳过双发关闭链**（R8-8）：close 幂等闩锁（叠加 R8-1 后最多 4 层
  遮罩）
- **预填覆写用户已选模板**（R8-9）：仅空时回填

（R8-10 a11y 焦点管理为已知弱点记录，后续专项）

## [0.7.26] — 2026-10-02

### Fixed
- **R7 审查最后一批（3 项，全部闭环）**：
- **活动流重建丢失展开态 + 强制滚底**（R7-15）：流式期间每个 delta/工具
  事件全量重建 DOM——用户展开的工具审计折叠区立即收回（审计透明功能恰在
  agent 运行中不可用）、上翻阅读被持续拽回底部。展开态存 Set（按列表
  下标，越界自动清理）+ 跟随式滚动（近底部才滚，否则保持位置）
- **更新检查生命周期**（R7-8）：did-finish-load 只挂首个 webContents
  （macOS 关窗重建后静默检查永不发生）→ 挂入 createWindow（每窗口机会）
  + 单次标记（reload 不重复网络检查）；下载期错误不再误报「检查失败」
  （DW_UPDATE_DOWNLOAD_FAILED 按阶段区分）

## [0.7.25] — 2026-10-02

### Fixed
- **终端潜伏面三项修复**（R7-7，接线前根治——渲染端尚无终端 UI，按潜在
  影响评估）：
- **会话泄漏**（R7-7a）：reload（默认菜单 Ctrl+R）/渲染进程崩溃后渲染端
  丢失会话 id，pty 会话与输出订阅全部滞留（shell 进程持续运行直到退出
  应用）——webContents 导航开始/进程崩溃时 disposeAll 回收
- **无 TerminalExit 推送**（R7-7b）：用户敲 exit 后主进程删会话但渲染端
  毫不知情，后续 input 得到 Unknown session 拒绝——新增 terminal:exit
  推送通道（contracts IPC + PUSH_CHANNELS + preload onExit +
  service onExit 订阅），渲染端未来接线即可收尾会话 UI
- **kill 不杀进程树**（R7-7c）：Windows 上裸 kill 只终止 shell 本进程，
  `npm run dev` 的 node 子孙进程存活（端口占用/CPU 持续）——双后端
  （pty/pipe）kill 改 `taskkill /pid /T /F` 树杀，POSIX 维持原语义

### Changed
- **E2E 跑批器前置闸**：dist/renderer/index.js 若为 tsc 裸 ESM 输出（部分
  重建漏跑 build:renderer 的产物事故——实测 34/34 套以同一「.dw-header
  超时」症状失败、根因难定位）提前失败并给出修复指引

## [0.7.24] — 2026-10-02

### Fixed
- **第七轮审查 minor 批（5 项）**：
- **导出 CSV 公式注入**（R7-12）：modeId/providerId/model 可含社区导入内容，
  `= + - @` 开头单元格在 Excel 打开可执行公式——加 `'` 前缀（OWASP 标准
  缓解；数字列不受影响）
- **trace-timeline O(n²) 渲染**（R7-13）：每可见行 indexOf 全数组——live 模式
  每事件全量重渲染，千级事件会话卡顿。seq→下标映射一次构建
- **轨迹视图 live 事件竞态丢失**（R7-14）：fetch 快照落后于已 push 的 live
  事件时整体替换使其从视图消失——同会话按 seq 合并（跨会话整体替换，
  会话隔离）
- **opt_out 信标发往用户未选择的端点**（R7-9）：configure 先换 config 再
  flush——用户先清空自建端点再关开关时告别信标发往内建 PostHog 云端。
  opt_out flush 固定用旧端点，完成后恢复新配置
- **外部编辑器模板边界**（R7-16）：路径中段引号（`C:\"My Tools"\code.exe`）
  切成两个错误 token——非成对引号回退空白分词；NaN 行号兜底 1（原命令行
  出现字面量 `:NaN`）

## [0.7.23] — 2026-10-02

### Fixed
- **主进程剩余模块对抗性审查修复（第七轮，critical 2 + major 5）**：

**Critical**
- **渲染层可控 root「重定根」**（R7-1）：WorkspaceTree/Search/CreateSample
  直接 openRoot(渲染层任意字符串)——被攻破的渲染层（威胁模型自述含模型
  输出注入）可静默把根切到 C:\ 后经 Read/Write 全盘读写。根状态只能经
  dialog 通道或主进程启动恢复路径变更；其余通道校验 root 与当前已开根
  一致（DW_WORKSPACE_ROOT_MISMATCH）。AC15 启动恢复改由主进程读
  session.state 一次性重建（残留风险诚实记录：先前攻破+重启的持久化
  向量，完整闭环需持久化签名）
- **containment 大小写归一化在敏感文件系统可绕过**（R7-2）：无条件
  toLowerCase 使 Linux 上大小写变体路径逃逸 root——归一化仅
  win32/darwin，Linux 精确比较

**Major**
- **will-quit 异步清理 fire-and-forget**（R7-3）：MCP 第 2..N 个 server
  的 kill、LSP 3s 强杀、DAP debuggee.kill、遥测 flush 全部不及执行——
  preventDefault + Promise.all 等待（单项 4s 兜底）后显式退出；
  telemetry.stop() 改返回 Promise
- **缺少单实例锁**（R7-4）：双开导致 SettingsStore 互相覆盖/子进程双份
  ——requestSingleInstanceLock + second-instance 聚焦
- **示例项目无确认覆盖既有文件**（R7-6）：误选已有项目目录时七个文件被
  不可逆覆盖——写前备份到 .devwit-sample-backup/（保留原相对路径）

## [0.7.22] — 2026-10-02

### Fixed
- **第六轮审查扫尾（3 项）**：
- **孤立 `\r`（旧 Mac）行尾不识别**（E6-8）：整篇一行——行号/折叠/
  minimap/自动缩进全错。computeLineStarts 兼容（`\r` 非 `\r\n` 前导时
  计为换行；`\r\n` 只在 `\n` 处计一次）
- **http-client activeAbort 单槽竞态**（E6-9）：并发请求互相覆盖——close
  只中止最新一个，先完成者 finally 误清后者控制器。改控制器集合
  （close 中止全部，finally 摘除自身）
- **piece-table 删除后相邻片合并**（E6-5 缓解）：deleteCore 重建后合并同
  缓冲区连续片——「插入再删除」与反复中部编辑的碎片数有界（200 轮中
  部插入+删除净零片，回归测试锁定；完整平衡树重构属中期项）

## [0.7.21] — 2026-10-02

### Fixed
- **editor-core / mcp / editor-render(layout) 对抗性审查修复（7 项）**——
  第六轮审查批次（此前未覆盖的编辑器数据结构层与 MCP 协议栈）：

**Major（5 项）**
- **点击 emoji 右半拆散代理对**（E6-1）：columnForXChars 中点判定返回高/
  低代理之间的列——打字把文本插进代理对内部，孤立代理（乱码方块）写入
  缓冲并持久化（数值复现验证；CJK 扩展 B 生僻字同样）。命中列吸附到
  码点左边界
- **MCP stdio stdin EPIPE 崩主进程**（E6-2）：服务器死亡窗口内写 stdin 触发
  无监听的 error 事件 → uncaughtException（与 v0.7.15 L14 的 LSP 同型修复，
  此处漏了同一行）。stdin error 吞掉 + 统一 writeLine 入口
- **MCP 服务器请求被误配为客户端挂起请求的响应**（E6-3）：带 method+数字
  id 的服务器请求（规范允许的 ping）命中同 id 挂起请求 → tools/list 静默
  变空集。先判 method（请求回空成功响应，通知忽略）
- **两传输层 UTF-8 跨块解码损坏**（E6-4）：逐块 toString 使 CJK 3 字节
  跨 pipe/网络块边界产生 U+FFFD → JSON 解析失败 → 响应丢弃（30s 超时）/
  HTTP NO_RESPONSE。stream 模式 TextDecoder（stdio + http 双侧）
- **piece-table 碎片无界增长**（E6-5，性能非正确性）：全部热路径
  O(pieces)——记录为已知取舍（平衡树重构属中期项，当前规模实测可接受）

**Minor（含加固）**
- **serverId 含 "__" 工具全名解析歧义**（E6-6）：id "a__b"+工具 "t" 跨服务
  器碰撞——校验 fail-closed 拒绝含 "__" 的 id
- **close() 无 SIGKILL 升级**（E6-7）：POSIX 上忽略 SIGTERM 的服务器成
  孤儿——3s 超时后升级 SIGKILL
- **cmd 注入黑名单漏 %**（E6-10）：%VAR% 变量展开可泄 env 值进 argv
- **getLastUndoRedoChanges 失败调用残留旧值**（E6-12）：与注释语义对齐

## [0.7.20] — 2026-10-02

### Fixed
- **rag / llm-providers / settings 对抗性审查修复（8 项）**——第五轮审查批次：

**Critical**
- **切换 embedding 模型后 RAG 检索静默失效**（R1）：持久化无模型指纹——
  换 embedModel/provider 后 mtime 未变零重嵌，旧维度向量与新查询余弦全 0
  （返回无关块或空），无报错永不自愈，「重建索引」也无效。files.json v2
  持久化 `providerId:embedModel` 指纹，不一致即全量重嵌（旧格式视为不
  一致，一次性升级成本）；refreshRag 指纹参与就绪判定（在线改配置立即
  生效）

**Major**
- **dispose 不取消进行中的 buildAll**（R2）：切工作区后旧索引继续对旧根
  烧 embedding 费用，完成后广播旧根的 ready 状态覆盖新索引。生命周期
  代数：任务在文件/批次边界中止，不再广播
- **一次网络错误后 error 态永久粘滞**（R3）：成功 syncFile 不回 ready——
  之后所有对话的代码库上下文都是占位项直到手动重建。成功路径无条件回
  ready（对齐 SymbolIndex 的自愈语义）
- **凭证解密失败不可见不可诊断**（R4）：换机/重装后 DPAPI 密钥已变——
  原始英文错误透传、设置页无损坏提示。映射 DW_CREDENTIAL_DECRYPT_FAILED
  （本地化）+ 落 corrupt 标记（横幅与重录清除机制复用）

**Minor**
- **tool_calls 增量缺 index 串桶**（R5）：兼容实现省略 index 时按 pending
  桶数顺延/按 id 复用（旧实现归 0 号桶 → JSON 拼坏 → 静默空参数执行）
- **空 SSE data 行作废整轮流出的回复**（R6）：网关 keep-alive 空帧跳过
  （anthropic/openai 双侧；非空畸形 JSON 仍报错）
- **索引孤儿块永久残留**（R7）：双 rename 断电窗口产物——load 时按
  files 表对账丢弃
- **`..` 开头命名的合法文件永不索引**（R8）：`..draft.ts` 被误判越界
  （codebase-index + symbol-index 两处）

## [0.7.19] — 2026-10-02

### Fixed
- **渲染面板四模块对抗性审查修复（16 项）**——git-panel / search-panel /
  lsp-ui / debug-panel（第四轮审查，此前未覆盖的面板模块）：

**Critical（2 项）**
- **git diff 覆盖层并发孤儿**（P1）：快速连点两个变更文件（首个 diff IPC 慢）
  叠出双覆盖层——不透明 inset:0 永久遮挡编辑器、孤儿层关闭按钮失效。
  代数守卫：await 返回后已有更新的 open/close 即作废
- **rename 跨文件写盘回滚重构**（P2）：F2 重命名跨文件符号后，其它已打开
  标签的内存 doc 过期——切过去 Ctrl+S 即把重构静默覆盖丢失。写盘后逐文件
  刷新已开标签缓冲（复用 v0.7.12 的按 path 定位 + 活动性分治）

**Major（8 项）**
- **搜索乱序覆盖**（P3）：主进程每次搜索新建 worker 并行执行，旧请求的
  超时/结果会覆盖新查询渲染并污染 replaceAll 的命中集——请求序号守卫
- **replaceAll 改写 CRLF 为 LF**（P4）：split(/\r?\n/) 吞 \r 后 join("\n")
  写回，Windows 行尾文件整文件变更——按文件原行尾风格保留
- **replaceAll 循环中切标签缓冲过期**（P5）：旧实现只刷「开始时」的活动
  文件——逐文件刷新（回调内部按 openFiles 定位，未打开自然 no-op）
- **弹层键盘全局劫持**（P6）：补全/签名/引用/rename/代码操作五个 window
  捕获监听不判事件目标——其它输入框的 Enter/Tab 被吞、补全文本写进编辑器、
  任意输入框打 "(" 弹签名浮层。目标守卫（编辑器 IME textarea）+ 焦点离开
  自动关弹层
- **hover 迟到响应常驻**（P7）：鼠标移出后 IPC 返回仍按旧坐标弹层并停留
  ——hideHover 代数使在途请求作废
- **分支下拉双开孤儿**（P8）：双击分支名双弹层 + document 捕获监听器泄漏
  ——打开中标记 + 注册窗口守卫
- **幽灵断点**（P9）：右键行号取消编辑后断点仍创建并下次启动生效——
  取消回滚新建断点
- **attach 端口重置**（P10）：面板重渲染把用户改的端口重置回 9229 →
  Attach 连错进程——端口值持久化

**Minor（6 项）**：P11 冲突解决失败仍提示成功（doGitOp 返回成败）/ P12
stash 成功提示误用按钮文案（补 git.stash.pushed 键）/ P13 rename 占位符
硬编码英文（补 lsp.rename.placeholder）/ P14 空引用浮层计时器误关新浮层 /
P15 跨文件编辑越界行号回退文件头（改跳过）/ P18 fire-and-forget 补
catch ×3

### Changed
- 编辑器折叠重算性能门控（v0.7.14 E11 的跟进）：仅结构性编辑（行数变化）
  触发全量重算——实测 20k 行碎片化文档单次 167ms，落在每击键会造成大文件
  输入卡顿；行内编辑不漂移行号（缩进边界陈旧为既有行为）

## [0.7.18] — 2026-10-02

### Fixed
- **GitService 调用串行化**（L12d）：status（读 index）与 stage/commit（写
  index.lock）并发时偶发 "index.lock exists" 冒泡给用户——同实例内全部 git
  调用经队列按序执行（失败/超时不阻塞队列；进程外并发仍由 git 锁语义兜底）。
  2 项伪 exec 单测锁定（按序执行 + 失败不卡队列）

### Changed
- **v0.7.17 已转正 Latest Release**（此前 Latest 停留在 v0.7.0——in-app
  自动更新通道现在向全部旧版用户交付 0.7.12 以来的 40 项审查修复）
- winget 0.7.17 清单补 zh-CN locale 与 ReleaseNotesUrl（四文件完整形态）；
  已提交 [winget-pkgs#438830](https://github.com/microsoft/winget-pkgs/pull/438830)

## [0.7.17] — 2026-10-02

### Fixed
- **三路对抗性审查修复第三批（8 项，收尾）**：
- **agent 工具符号链接逃逸**（A13，安全）：resolveWithinRoot 词法防线看不见
  symlink——工作区内指向区外的链接可让授权后的 write/edit 写出工作区。
  补真实路径复核（最近存在祖先回退，与 workspace-service 同口径）
- **含失败子任务的编排 run 仍记成功并学习**（A11）：综合照常完成返回
  completed，但失败样本进入 modeStats（成功率虚高、推荐失真）与工作流
  记忆（坏模板被复用注入）。有 subagent error 终态时不学习、不定级
- **MCP 工具调用不受取消影响**（A10）：abort 后最长 30s 在途调用照常等满
  ——与取消信号竞速，立即返回「已取消」（孤儿结果吞掉防 unhandled rejection）
- **git 分支名选项注入**（L12b）：前导 `-` 的名字被 git 当选项（如
  checkout("-f") 强检丢弃修改）——git ref 规则本就禁止，提前拒绝
  DW_GIT_INVALID_BRANCH_NAME
- **搜索 preview 无截断 + BOM 列号偏移**（L9b/c）：巨型单行文件整行进
  preview × 上千命中 = IPC 载荷爆炸——截 200 字符；UTF-8 BOM 使首行
  列号整体 +1——先剥离再匹配
- **RAG 块级开关「弹回」**（C6）：latestManifest 只在下次 build 重建——
  改开关后 refresh 用旧 manifest 把显示弹回（状态已改、显示撒谎）。本地
  乐观更新，下次真实 build 后校准
- **enforce 预算无单价表静默失效**（A14）：成本恒 0 永不拦截且无提示——
  stderr 一次性 ASCII 告警使失效模式可发现

## [0.7.16] — 2026-10-02

### Fixed
- **三路对抗性审查修复第二批（14 项）**——需设计项为主：

**并发正确性**
- **编排子 Agent 孤儿化**（A3）：单个子 Agent 基础设施异常（build/send IO
  错误）时 Promise.all 即整体 reject，其余 worker 不被取消、继续消费队列
  跑完——后台持续改文件/烧 token 且结果丢弃。mapWithConcurrency 异常隔离
  （停派发 + 回调中止）+ 本地取消链（外部/异常取消传导至全部子 Agent）；
  编排异常转 error 终态（用量入账、轨迹可审计、会话正常收尾）
- **PromptSectionRegistry 跨模式污染**（A4）：注册表被各 run clear+重装共享
  单份——任务中心与聊天并发不同模式 run 时，A 会话后续迭代拼入 B 模式的
  mode-scope 段。段增加 modeId 归属，assemble 按 ctx.modeId 过滤，sync
  不再全局 clear（mode 基座段注册一次，文本经 modeTextOverride 每 run 覆盖）
- **并行子 Agent 工具结果配对错位**（C2）：「倒序找最后一个未决 tool 项」
  只对串行成立——事件序 A.call→B.call→A.result 时 A 的结果填进 B 的行。
  tool 项记录 subagentId 归属，结果按归属配对（旧轨迹无归属时兜底原语义）

**Windows/中文环境**
- **git_status 中文路径乱码**（L6）：非 -z porcelain 对非常规路径输出
  `"\346..."` 八进制转义（agent 拿到不可用路径）；含 " -> " 的文件名被误判
  rename。改 `--porcelain=v1 -z`（与 git-service 统一口径）
- **Windows 目录 junction 被递归跟随**（L8）：readdir Dirent 在 Windows 把
  目录 reparse point 报为 directory——指向工作区外的 junction 递归进入
  （破坏 search 防逃逸保证）。lstat 复核（libuv 把 junction 映射为
  symbolic link），一律按 file 不递归（与 Linux 对齐）
- **showHead 未知错误伪装「无 HEAD 版」**（L12a）：超时等异常被当作 untracked
  → diff 误显示全新增。改上抛 DW_GIT_SHOW_HEAD_FAILED（诚实降级）

**LSP/DAP**
- **步进失败后调试状态机锁死**（L3）：next/stepIn/stepOut 先置 running 再
  发请求，失败无回滚——UI 永卡 running、后续全抛 NOT_STOPPED。失败回滚
  stopped 态与 stopThreadId
- **tcp 监听行只盯 stdout 首行**（L5）：适配器首行输出告警时永远检测不到
  监听行 → LISTEN_TIMEOUT。改逐行消费扫描

**工具与搜索**
- **agent grep worker exit 监听器泄漏**（L10）：常驻 worker 每请求累积一个
  匿名 exit 监听器，>10 次 MaxListenersExceededWarning 刷屏——成功路径
  三个监听器统一摘除
- **search-worker 共享 regex 隔行漏配**（L11）：flags 含 "g" 时 lastIndex
  跨行推进——逐行重置（协议级防御，当前调用方未触发）

**渲染层**
- **多个待裁决授权时任务状态误翻回「进行中」**（C7）：并行子 Agent 共享
  授权门可同时产生多个 pending——按 requestId 记账，仍有未决则保持
  waiting_auth
- **改名中切换语言冻死会话列表**（C8）：全量重绘销毁改名输入框但 editingId
  残留，后续改名/切换全被守卫拦截——render 时复位残留编辑态
- **围栏内含 ``` 行静默截断提案**（C4）：非贪婪匹配在内层围栏假闭合，
  恰好 1 个匹配通过唯一性校验——「接受」写入残缺代码。闭合后剩余文本仍含
  ``` 则按多块契约诚实降级 null

## [0.7.15] — 2026-10-02

### Fixed
- **三路对抗性审查修复第一批（18 项）**——agent 核心（ai-runtime +
  agent-runtime）、chat-ui/context-engine、lsp/dap/workspace 三路审查共 40
  项发现，本批修复高影响小改动 18 项，需设计项（并发编排/注册表隔离/
  工具归属配对等）留下批：

**功能全灭/数据损坏级**
- **上下文面板「刷新/导出」按钮从未显示**（C1）：applyLocale 对 header 赋
  textContent 会删除全部子节点——挂载即销毁按钮，manifest 导出功能 100%
  不可达。标题改独立子节点
- **attach 模式停止调试杀死用户进程**（L1，critical）：DapClient.close 硬编码
  terminateDebuggee:true，attach 会话（用户自己的 --inspect 进程）点停止即被
  终止——与类注释契约矛盾。close 增加参数，attach 传 false（仅 detach）
- **CRLF 文件 diff 退化 + 混合换行符写回**（C3）：Windows 检出（CRLF）× LLM
  提案（LF）每行都判不同——整文件一个巨型 hunk 逐块审查失效；部分接受后
  写回 LF/CRLF 混排（git 整文件标红）。diffLines 加 stripTrailingCr（GNU
  diff 同语义），合成时按原文行尾风格统一还原（全拒绝也逐字节一致）
- **LSP stdin EPIPE 崩主进程**（L14）：服务器死亡后、exit 送达前的窗口内
  写 stdin 触发无监听的 error 事件 → uncaughtException。一行修复

**会话与运行时正确性**
- **删除会话不清 pending 授权**（A1）：等待裁决的 run 永久挂起（pending
  Promise 不监听 abort，会话删除后 authorize 恒 false）；且收尾事件把已删
  轨迹文件重新写出来（「彻底删除」被破坏）。删除先 cancelPending；
  persistTraceEvent 拒绝已删会话
- **running=true 在 try/finally 之外**（A2）：route 轨迹的 send（窗口销毁
  瞬间可抛）/工作流 settings 写入任一抛错 → 会话永久 DW_SESSION_BUSY 且
  不被 LRU 逐出。running 置位后全部纳入 try/finally；onRecord send 吞错
- **preStep 拒绝丢已累积 usage**（A5）+ **engine.build 抛错丢部分 usage**
  （A6）：均改 error 终态返回并保留用量（与注释「出错也记录部分量」对齐）
- **轨迹 seq 碰撞**（A7）：坏行恢复后 events.length+1 与盘上最大 seq 碰撞
  （append-only 不变量破）——nextSeq 按历史最大 seq 续排
- **sessions.json 非原子写**（A8）：崩溃截断丢全部 deleted 标记（已删会话
  可复活）——tmp+rename 原子写（与 settings 同口径）
- **git_\* 工具不传播取消**（A9）：大仓库 git_log/diff 取消后仍跑满超时
  ——execFile 透传 signal
- **全失败模式被推荐**（A12）：shouldRecommend 的 0>=0 退化——全失败候选
  （rate=0）在当前无数据（?? 0）时被等号放过；加 candidateRate > 0 下限
  （并列成功模式的「不差于即推荐」原语义保留，verify-i22 锁定）

**LSP/DAP 加固**
- **rootInitialized 无超时**（L2）：适配器对 attach 直接回错误时启动永久
  悬挂在 starting——与 inspectorReady/companionReady 同口径 withTimeout
- **socket 先死时适配器进程泄漏**（L4）：handleExit 置 null 不 kill，进程
  引用永久丢失——通道侧死亡补杀
- **LSP 服务器请求被当响应派发**（L13）：先判 method 再判 id；服务器请求
  回 error 响应（不挂起服务器）
- **close 最坏阻塞 33s**（L16）：shutdown 套用 30s 请求超时与注释矛盾——
  单独 2s 超时
- **旧代服务器迟到诊断污染新代**（L15）：onNotification 补代际守卫
  （与 onExit 对齐）

**渲染层**
- **流中断的 assistant 项永久 streaming**（C5）：终态（done/error）前以已
  累积文本收尾（streamError 路径无 assistant_message 定稿事件）

### Changed
- diff-controller 新增 originalUsesCrlf 字段（合成侧行尾还原依据，单测锁定）

## [0.7.14] — 2026-10-02

### Fixed
- **编辑后折叠区域失同步**（E11，审查遗留轻微项）：打开文件后在顶部按
  Enter 插行，所有折叠区域行号整体偏移——折叠标记画错行、隐藏区间失真；
  宿主除 setDocument 外没有任何编辑后重算调用，「集成方负责」契约在内部
  打字路径下不可维持。现在编辑置脏、渲染前一次性重算（rAF 合并连击，
  O(行数) 不落在每击键上），用户折叠态按「头行文本 + 相对顺序」迁移
- **Alt+Up/Down 行移动丢弃其余光标**（E9）：多光标下移动行块只保留主光标，
  其余静默消失——改为按行归属平移全部光标（块内 +方向、交换邻行 -方向、
  块外不动）并去重
- **Shift+Alt+Up/Down 行复制平移块上方光标**（E9）：复制插入点上方区域
  的行不移动，旧实现把全部光标一律 +块高——只有块内及其下方光标平移
- **视口变大后 scrollTop 超上限**（E12）：resize() 补 clampScroll（纯视觉
  瞬态）；wheel 滚轮 deltaMode 归一化（Firefox 行/页模式此前几乎滚不动，
  Electron/Chromium 不受影响属可复用包加固）

### Changed
- **fire-and-forget IPC 链统一吞错可见化**（F10）：模式/模型热更新链、白名单
  初始读取、示例项目创建链、模式删除链、预设目录初始 IIFE——任一失败不再
  unhandled rejection 无感知（runBackground 辅助 / localizeError / 新增
  err.sampleFailed 词典键，中英）

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
