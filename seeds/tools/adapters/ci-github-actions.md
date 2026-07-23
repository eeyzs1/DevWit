# GitHub Actions CI Adapter

吸收自：union 框架 `adapters/ci/github-actions/adapter.md`

触发 GitHub Actions workflow 运行并监控其状态。

## Setup

```yaml
# project.yaml
adapters:
  ci:
    type: "github-actions"
    config:
      repo: "owner/repo"
      token_env: "GITHUB_TOKEN"
      workflow_file: "deploy.yml"
```

## 实现注意事项

- 使用 GitHub REST API 进行 workflow dispatch 和 run 监控
- `trigger()` 创建 `workflow_dispatch` 事件
- `waitForCompletion()` 使用指数退避轮询 run 状态
- Token 需要 `actions:write` scope（dispatch）和 `actions:read`（status）