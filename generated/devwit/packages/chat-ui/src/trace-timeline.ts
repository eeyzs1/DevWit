/**
 * 轨迹时间线视图（迭代 27 / AC36）：侧栏「轨迹」页签。
 *
 * 把一次会话的持久化轨迹事件渲染为可审计时间线：
 * - 每条事件：seq 徽标 + 类型徽标 + 时间戳 + 相对上一条事件的耗时（+Δms）+ 摘要，
 *   点击展开完整 detail（工具参数/结果等结构化数据）；
 * - 类型过滤（全部/消息/工具/授权/用量/失败）；
 * - 失败类事件高亮（isFailureTraceEvent 同规则），「跳到下一个失败」导航；
 * - 会话回放：选择历史会话（traces/ 落盘摘要列表）后进入回放模式，
 *   步进/自动播放/重置逐条重现事件序；当前活跃会话则实时追加。
 *
 * 纯函数（filterTraceEvents / deltaMs）导出供单测；DOM 部分不接触任何
 * electron API，只经 DevwitApi 白名单取数（AR001/AR004）。
 */
import { isFailureTraceEvent } from "@devwit/contracts";
import type { AgentTraceEvent, AgentTraceEventType, DevwitApi, TraceSessionInfo } from "@devwit/contracts";
import { onDidChangeLocale, t } from "@devwit/i18n";

// ---------------------------------------------------------------------------
// 纯函数（单测覆盖）
// ---------------------------------------------------------------------------

export type TraceFilter = "all" | "messages" | "tools" | "authorization" | "usage" | "failures";

/** 过滤类别 → 事件类型集合（failures 走 isFailureTraceEvent 判定，不在此表）。 */
const FILTER_TYPES: Record<Exclude<TraceFilter, "all" | "failures">, ReadonlySet<AgentTraceEventType>> = {
  messages: new Set<AgentTraceEventType>(["user_message", "assistant_message"]),
  tools: new Set<AgentTraceEventType>(["tool_call", "tool_result"]),
  authorization: new Set<AgentTraceEventType>([
    "authorization_request",
    "authorization_decision",
    "authorization_auto",
  ]),
  usage: new Set<AgentTraceEventType>(["usage"]),
};

/** 按过滤类别筛选事件（保持原序）。 */
export function filterTraceEvents(events: AgentTraceEvent[], filter: TraceFilter): AgentTraceEvent[] {
  if (filter === "all") return events;
  if (filter === "failures") return events.filter((event) => isFailureTraceEvent(event));
  const types = FILTER_TYPES[filter];
  return events.filter((event) => types.has(event.type));
}

/**
 * 相邻事件耗时差（毫秒）：next - prev。
 * 时间戳非法或乱序（next 早于 prev）时返回 null——UI 不显示负耗时。
 */
export function deltaMs(prevIso: string, nextIso: string): number | null {
  const prev = Date.parse(prevIso);
  const next = Date.parse(nextIso);
  if (Number.isNaN(prev) || Number.isNaN(next) || next < prev) return null;
  return next - prev;
}

/** 事件类型 → 词典键（类型安全映射，模板串键无法通过 MessageKey 检查）。 */
type TraceTypeMessageKey = Parameters<typeof t>[0];
export const TRACE_TYPE_KEY: Record<AgentTraceEventType, TraceTypeMessageKey> = {
  user_message: "trace.type.user_message",
  assistant_message: "trace.type.assistant_message",
  assistant_delta: "trace.type.assistant_delta",
  tool_call: "trace.type.tool_call",
  authorization_request: "trace.type.authorization_request",
  authorization_decision: "trace.type.authorization_decision",
  authorization_auto: "trace.type.authorization_auto",
  tool_result: "trace.type.tool_result",
  diagnostics: "trace.type.diagnostics",
  route: "trace.type.route",
  workflow: "trace.type.workflow",
  mode_recommend: "trace.type.mode_recommend",
  usage: "trace.type.usage",
  plan: "trace.type.plan",
  subagent_start: "trace.type.subagent_start",
  subagent_done: "trace.type.subagent_done",
  error: "trace.type.error",
  done: "trace.type.done",
};

// ---------------------------------------------------------------------------
// DOM 组件
// ---------------------------------------------------------------------------

export interface TraceTimelineOptions {
  api: DevwitApi;
  /** 当前活跃会话 id（会话下拉首选，标注「当前会话」并实时追加新事件）。 */
  liveSessionId: string;
}

export interface TraceTimelineHandle {
  readonly root: HTMLElement;
  /** 活跃会话切换（如恢复历史会话后）调用：同步下拉首选并刷新。 */
  setLiveSession(sessionId: string): void;
  /** 重新拉取会话摘要列表 + 当前选中会话的完整轨迹。 */
  refresh(): Promise<void>;
  dispose(): void;
}

/** 自动播放步进间隔（ms）：可读节奏，不追求速度。 */
const REPLAY_INTERVAL_MS = 250;

export function mountTraceTimeline(container: HTMLElement, options: TraceTimelineOptions): TraceTimelineHandle {
  const root = document.createElement("div");
  root.className = "dw-trace";
  container.appendChild(root);

  let liveSessionId = options.liveSessionId;
  let sessions: TraceSessionInfo[] = [];
  let selected = liveSessionId;
  let events: AgentTraceEvent[] = [];
  let filter: TraceFilter = "all";
  let replaying = false;
  let visibleCount = 0;
  let failCursor = -1;
  let statusNote = "";
  const expanded = new Set<number>();
  let playTimer: number | undefined;

  function stopPlay(): void {
    window.clearInterval(playTimer);
    playTimer = undefined;
  }

  /** 当前过滤后的可见序列（回放模式再按 visibleCount 截断）。 */
  function visibleEvents(): AgentTraceEvent[] {
    const filtered = filterTraceEvents(events, filter);
    return replaying ? filtered.slice(0, visibleCount) : filtered;
  }

  function renderRow(event: AgentTraceEvent, indexInFull: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "dw-trace-row";
    row.dataset["seq"] = String(event.seq);
    if (isFailureTraceEvent(event)) row.classList.add("dw-trace-fail");

    const seq = document.createElement("span");
    seq.className = "dw-trace-seq";
    seq.textContent = `#${event.seq}`;
    const badge = document.createElement("span");
    badge.className = `dw-trace-badge dw-trace-badge-${event.type}`;
    badge.textContent = t(TRACE_TYPE_KEY[event.type]);
    const time = document.createElement("span");
    time.className = "dw-trace-time";
    // ISO 时间戳取 HH:MM:SS.mmm 段（日期由会话摘要承载，行内只显时刻）
    time.textContent = event.timestamp.length >= 23 ? event.timestamp.slice(11, 23) : event.timestamp;
    row.append(seq, badge, time);

    // 相对上一条事件的耗时（全轨迹相邻，而非过滤后相邻——审计口径一致）
    const prev = events[indexInFull - 1];
    if (prev !== undefined) {
      const delta = deltaMs(prev.timestamp, event.timestamp);
      if (delta !== null) {
        const deltaNode = document.createElement("span");
        deltaNode.className = "dw-trace-delta";
        deltaNode.textContent = `+${delta} ms`;
        row.appendChild(deltaNode);
      }
    }

    const summary = document.createElement("div");
    summary.className = "dw-trace-summary";
    summary.textContent = event.summary;
    row.appendChild(summary);

    if (expanded.has(event.seq)) row.classList.add("dw-trace-expanded");
    if (event.detail !== undefined) {
      row.classList.add("dw-trace-has-detail");
      row.title = t("trace.expand.tooltip");
      row.addEventListener("click", () => {
        if (expanded.has(event.seq)) {
          expanded.delete(event.seq);
        } else {
          expanded.add(event.seq);
        }
        render();
      });
      if (expanded.has(event.seq)) {
        const detail = document.createElement("pre");
        detail.className = "dw-trace-detail";
        detail.textContent = JSON.stringify(event.detail, null, 2);
        row.appendChild(detail);
      }
    }
    return row;
  }

  function render(): void {
    root.textContent = "";

    // ---- 工具栏：会话选择 / 类型过滤 / 失败导航 / 回放控制 ----
    const toolbar = document.createElement("div");
    toolbar.className = "dw-trace-toolbar";

    const sessionSelect = document.createElement("select");
    sessionSelect.className = "dw-select dw-trace-session";
    sessionSelect.title = t("trace.session.tooltip");
    const liveOption = document.createElement("option");
    liveOption.value = liveSessionId;
    liveOption.textContent = t("trace.session.current");
    sessionSelect.appendChild(liveOption);
    for (const info of sessions) {
      if (info.sessionId === liveSessionId) continue; // 活跃会话已由首选承载
      const option = document.createElement("option");
      option.value = info.sessionId;
      option.textContent = t("trace.session.option", {
        time: info.startedAt.slice(0, 16).replace("T", " "),
        preview: info.preview.length > 24 ? `${info.preview.slice(0, 24)}…` : info.preview,
        count: info.eventCount,
      });
      sessionSelect.appendChild(option);
    }
    sessionSelect.value = selected;
    // 选中项可能不在列表中（新会话尚无落盘事件）→ 追加一个占位项保持选中态
    if (sessionSelect.value !== selected) {
      const pending = document.createElement("option");
      pending.value = selected;
      pending.textContent = selected;
      sessionSelect.appendChild(pending);
      sessionSelect.value = selected;
    }
    sessionSelect.addEventListener("change", () => {
      selected = sessionSelect.value;
      replaying = false;
      stopPlay();
      failCursor = -1;
      expanded.clear();
      void loadEvents();
    });
    toolbar.appendChild(sessionSelect);

    const filterSelect = document.createElement("select");
    filterSelect.className = "dw-select dw-trace-filter";
    filterSelect.title = t("trace.filter.tooltip");
    const filters: TraceFilter[] = ["all", "messages", "tools", "authorization", "usage", "failures"];
    for (const value of filters) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = t(`trace.filter.${value}`);
      filterSelect.appendChild(option);
    }
    filterSelect.value = filter;
    filterSelect.addEventListener("change", () => {
      filter = filterSelect.value as TraceFilter;
      failCursor = -1;
      render();
    });
    toolbar.appendChild(filterSelect);

    const jumpBtn = document.createElement("button");
    jumpBtn.className = "dw-btn dw-btn-small dw-trace-jump";
    jumpBtn.textContent = t("trace.jump.failure");
    jumpBtn.addEventListener("click", () => {
      const visible = visibleEvents();
      const failures = visible.filter((event) => isFailureTraceEvent(event));
      if (failures.length === 0) {
        statusNote = t("trace.noFailure");
        render();
        return;
      }
      failCursor = (failCursor + 1) % failures.length;
      const target = failures[failCursor]!;
      statusNote = "";
      render();
      const row = root.querySelector(`.dw-trace-row[data-seq="${target.seq}"]`);
      if (row !== null) {
        row.classList.add("dw-trace-current");
        row.scrollIntoView({ block: "center" });
      }
    });
    toolbar.appendChild(jumpBtn);

    // 回放控制：仅历史（非活跃）会话可回放——活跃会话实时追加语义更清晰
    if (!replaying) {
      const replayBtn = document.createElement("button");
      replayBtn.className = "dw-btn dw-btn-small dw-trace-replay";
      replayBtn.textContent = t("trace.replay.enter");
      replayBtn.disabled = selected === liveSessionId || events.length === 0;
      replayBtn.title = t("trace.replay.tooltip");
      replayBtn.addEventListener("click", () => {
        replaying = true;
        visibleCount = 0;
        failCursor = -1;
        render();
      });
      toolbar.appendChild(replayBtn);
    } else {
      const stepBtn = document.createElement("button");
      stepBtn.className = "dw-btn dw-btn-small dw-trace-step";
      stepBtn.textContent = t("trace.replay.step");
      stepBtn.addEventListener("click", () => {
        visibleCount = Math.min(visibleCount + 1, filterTraceEvents(events, filter).length);
        render();
      });
      const playBtn = document.createElement("button");
      playBtn.className = "dw-btn dw-btn-small dw-trace-play";
      playBtn.textContent = playTimer !== undefined ? t("trace.replay.pause") : t("trace.replay.play");
      playBtn.addEventListener("click", () => {
        if (playTimer !== undefined) {
          stopPlay();
        } else {
          playTimer = window.setInterval(() => {
            const totalCount = filterTraceEvents(events, filter).length;
            visibleCount = Math.min(visibleCount + 1, totalCount);
            if (visibleCount >= totalCount) stopPlay();
            render();
          }, REPLAY_INTERVAL_MS);
        }
        render();
      });
      const resetBtn = document.createElement("button");
      resetBtn.className = "dw-btn dw-btn-small dw-trace-reset";
      resetBtn.textContent = t("trace.replay.reset");
      resetBtn.addEventListener("click", () => {
        stopPlay();
        visibleCount = 0;
        render();
      });
      const exitBtn = document.createElement("button");
      exitBtn.className = "dw-btn dw-btn-small dw-trace-exit";
      exitBtn.textContent = t("trace.replay.exit");
      exitBtn.addEventListener("click", () => {
        replaying = false;
        stopPlay();
        render();
      });
      const progress = document.createElement("span");
      progress.className = "dw-trace-progress";
      progress.textContent = t("trace.replay.progress", {
        shown: visibleCount,
        total: filterTraceEvents(events, filter).length,
      });
      toolbar.append(stepBtn, playBtn, resetBtn, exitBtn, progress);
    }
    root.appendChild(toolbar);

    if (statusNote !== "") {
      const note = document.createElement("div");
      note.className = "dw-trace-note";
      note.textContent = statusNote;
      root.appendChild(note);
    }

    // ---- 事件列表 ----
    const list = document.createElement("div");
    list.className = "dw-trace-list";
    const visible = visibleEvents();
    if (visible.length === 0) {
      const empty = document.createElement("div");
      empty.className = "dw-trace-empty";
      empty.textContent = replaying ? t("trace.replay.hint") : t("trace.empty");
      list.appendChild(empty);
    } else {
      for (const event of visible) {
        const indexInFull = events.indexOf(event);
        list.appendChild(renderRow(event, indexInFull));
      }
    }
    root.appendChild(list);
  }

  async function loadEvents(): Promise<void> {
    events = (await options.api.agent.trace(selected)).filter((event) => event.type !== "assistant_delta");
    render();
  }

  async function refresh(): Promise<void> {
    sessions = await options.api.agent.traceList();
    await loadEvents();
  }

  // 活跃会话实时追加（回放/查看历史时不打扰）：delta 瞬时事件不进持久时间线
  const unsubscribeEvents = options.api.agent.onEvent((event) => {
    if (event.sessionId !== selected || event.type === "assistant_delta") return;
    if (replaying) return;
    events.push(event);
    render();
    const list = root.querySelector(".dw-trace-list");
    if (list !== null) list.scrollTop = list.scrollHeight;
  });

  // 语言热生效（AC12）：徽标/按钮/空态按新语言重绘（选择状态保留）
  const unsubscribeLocale = onDidChangeLocale(render);

  render();
  void refresh();

  return {
    root,
    setLiveSession(sessionId: string): void {
      liveSessionId = sessionId;
      render();
    },
    refresh,
    dispose(): void {
      stopPlay();
      unsubscribeEvents();
      unsubscribeLocale();
      root.remove();
    },
  };
}
