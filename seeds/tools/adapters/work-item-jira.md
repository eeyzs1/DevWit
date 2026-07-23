# Jira Work-Item Adapter

吸收自：union 框架 `adapters/work-item/jira/adapter.md`

将框架工单操作映射到 Jira REST API（Cloud 和 Server）。

## Setup

```yaml
# project.yaml
adapters:
  work_item:
    type: "jira"
    config:
      base_url: "https://your-domain.atlassian.net"
      email_env: "JIRA_EMAIL"
      token_env: "JIRA_API_TOKEN"
      project_key: "PROJ"
```

## Status Mapping

| 框架状态 | Jira Status（可配置） |
|---|---|
| `open` | `To Do` |
| `in_progress` | `In Progress` |
| `done` | `Done` |
| `blocked` | `Blocked` |

## Category Mapping

| 框架类别 | Jira Issue Type |
|---|---|
| `feature` | `Story` |
| `bug` | `Bug` |
| `task` | `Task` |
| `req` | `Epic` or `Story` |

## 实现注意事项

- 使用 Jira REST API v3
- 支持通过 `config.field_mapping` 自定义字段映射
- 转换按名称解析（非 ID），跨项目可移植
- 评论以 markdown 格式添加为 Jira 评论