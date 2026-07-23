# File Work-Item Adapter

吸收自：union 框架 `adapters/work-item/file/adapter.md`

默认的零依赖工单适配器。将工单存储为磁盘上的 JSON 文件。无需外部系统。

## 工作原理

所有工单以 JSON 文件形式存储在 `.meta-harness/work-items/` 下：

```
.meta-harness/work-items/
  items/
    WI-001.json
    WI-002.json
  index.json          # 所有工单 ID 列表
```

## Item Schema

```json
{
  "id": "WI-001",
  "title": "Add user login",
  "description": "Implement email/password login with JWT",
  "status": "open",
  "category": "feature",
  "priority": "medium",
  "assignee": null,
  "url": null,
  "created": "2026-06-12T10:00:00Z",
  "updated": "2026-06-12T10:00:00Z",
  "comments": []
}
```

## Status Flow

```
open → in_progress → done
                  → blocked
```

## 使用场景

- 无需真实工单追踪器的本地开发
- 框架原型开发
- 小型个人项目

## 何时切换

迁移到真实适配器（GitHub Issues, Jira, Linear 等）当：
- 需要多用户协作
- 需要通知/自动化
- 需要将工单链接到外部系统
- 团队已使用特定的工单追踪器