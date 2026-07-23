#!/usr/bin/env python3
"""
Workitem Source — 抽象基类（domain-agnostic）

meta-harness 提供接口契约，**不提供具体实现**。
LLM 在 GENERATE 阶段根据 task.yaml 的 work_source 合成具体 adapter：
  - runtime/sources/yunxiao_source.py     （云效 API）
  - runtime/sources/github_issues_source.py（GitHub Issues）
  - runtime/sources/local_file_source.py   （本地 file watcher / task.yaml）
  - runtime/sources/jira_source.py         （Jira REST API）
  - ……

具体 adapter 必须继承本基类并实现全部抽象方法。validate-harness.py check #9
会用 importlib 加载 adapter，校验所有抽象方法都被实现（不是 ABC 仍 abstractmethod 的子类）。

为什么是抽象基类而非具体实现：
  1. work source 高度项目特定——meta-harness 不预设任何平台
  2. 接口契约稳定（claim/fetch/update/archive），实现可换
  3. 与 fixer-registry 模式一致：通用接口 + 项目特定实现

接口契约（4 个抽象方法）：
  claim_next(policy)        → Optional[workitem_id]    领一个 workitem
  fetch_brief(workitem_id)  → dict                     获取详情（title/description/ac/effort）
  update_status(id, status) → None                     更新状态（claimed/in_progress/done/blocked）
  archive(id, result, summary) → None                  归档（写回 source 系统 + 本地 events）

policy 参数（claim_next 的策略）：
  - "fifo"      先进先出
  - "priority"  按 priority 字段
  - "critical"  只领 critical
  - "any"       任意可领

所有方法必须支持幂等——同 id 重复 claim 应返回同一 workitem（不创建新分支）。

Usage:
  # 在生成的 harness runtime/sources/<name>_source.py:
  from runtime.workitem_source import WorkitemSource

  class YunxiaoSource(WorkitemSource):
      def __init__(self, config: dict):
          ...
      def claim_next(self, policy: str) -> Optional[str]:
          ...

  # supervisor.py 通过 factory 加载：
  def load_source(config: dict) -> WorkitemSource:
      mod = importlib.import_module(f"runtime.sources.{config['adapter']}")
      cls = getattr(mod, config['class_name'])
      return cls(config)
"""

from abc import ABC, abstractmethod
from typing import Optional


class WorkitemSource(ABC):
    """抽象 workitem source。具体 adapter 由 LLM 在 GENERATE 合成。"""

    @abstractmethod
    def claim_next(self, policy: str = "any") -> Optional[str]:
        """领一个 workitem。

        Args:
            policy: 领取策略（fifo / priority / critical / any）

        Returns:
            workitem_id（str），无候选返回 None。同 id 重复 claim 应返回同一 id（幂等）。
        """
        raise NotImplementedError

    @abstractmethod
    def fetch_brief(self, workitem_id: str) -> dict:
        """获取 workitem 详情。

        Returns:
            dict 至少含：title, description, acceptance_criteria (list), effort (str),
            priority (str), metadata (dict)。
            fetch 不应改 status——只读。
        """
        raise NotImplementedError

    @abstractmethod
    def update_status(self, workitem_id: str, status: str) -> None:
        """更新 workitem 状态。

        status ∈ {claimed, in_progress, done, blocked, archived}。
        实现负责写回 source 系统（如云效 API PATCH）+ 本地 events 流。
        失败应抛异常（让 supervisor 决定重试还是 stop）。
        """
        raise NotImplementedError

    @abstractmethod
    def archive(self, workitem_id: str, result: str, summary: str) -> None:
        """归档 workitem。

        Args:
            result: "passed" / "failed" / "blocked"
            summary: 简短人类可读总结（≤200 字）

        实现：
          1. 写回 source 系统（关闭 issue / 标记 done）
          2. 写本地 events 流（archive 事件 + summary）
        幂等：同 id 多次 archive 应是 no-op（不重复写 events）。
        """
        raise NotImplementedError

    # 可选 hooks（子类可 override，不强制）
    def list_pending(self, limit: int = 50) -> list:
        """列出待领 workitem（默认实现：返回空，由 adapter override）。

        用于 supervisor rebalance / 启动时打印队列状态。
        """
        return []

    def heartbeat(self, workitem_id: str) -> None:
        """向 source 系统发心跳（表示本进程仍在处理）。

        默认 no-op，需要心跳的 adapter override（如云效防止 stale claim）。
        """
        return None


# ============================================================================
# Factory：supervisor.py 通过此函数加载 adapter
# ============================================================================

def load_source(config: dict):
    """根据 config 加载具体 adapter 实例。

    config 结构（来自 planning/workitem-source.yaml）：
        adapter: yunxiao           # 模块名（runtime/sources/yunxiao_source.py）
        class_name: YunxiaoSource  # 类名
        # ...其他 adapter 特定配置

    Returns:
        WorkitemSource 子类实例

    Raises:
        ImportError / AttributeError / TypeError —— 让 supervisor 决定 stop。
    """
    import importlib

    adapter_name = config.get("adapter")
    class_name = config.get("class_name")
    if not adapter_name or not class_name:
        raise ValueError(
            "workitem-source.yaml must declare 'adapter' (module name in "
            "runtime/sources/) and 'class_name'"
        )

    # adapter 模块路径约定：runtime/sources/<adapter>_source.py
    module_path = f"runtime.sources.{adapter_name}_source"
    mod = importlib.import_module(module_path)
    cls = getattr(mod, class_name)
    instance = cls(config)

    # 校验实现了所有抽象方法
    if isinstance(instance, WorkitemSource):
        return instance
    raise TypeError(
        f"{class_name} does not inherit from WorkitemSource — adapter contract violated"
    )
