# GitHub Issues Work-Item Adapter

吸收自：union 框架 `adapters/work-item/github-issues/adapter.md`

将框架工单操作映射到 GitHub Issues API。

## Setup

```yaml
# project.yaml
adapters:
  work_item:
    type: "github-issues"
    config:
      repo: "owner/repo"
      token_env: "GITHUB_TOKEN"
```

## Status Mapping

| 框架状态 | GitHub State |
|---|---|
| `open` | `open` |
| `in_progress` | `open` + assignee set |
| `done` | `closed` as `completed` |
| `blocked` | `open` + label `blocked` |

## Category Mapping

| 框架类别 | GitHub Label |
|---|---|
| `feature` | `enhancement` |
| `bug` | `bug` |
| `task` | `task` |
| `req` | `requirement` |

## 实现注意事项

- 使用 GitHub REST API（无 SDK 依赖）
- 支持分页
- 通过 retry-after 处理速率限制
- Token 需要 `repo` scope（私有仓库）或 `public_repo`（公开仓库）