# Noop CI Adapter

吸收自：union 框架 `adapters/ci/noop/adapter.md`

默认 CI 适配器。什么都不做——所有 CI 操作都是空操作。

## 使用场景

- 无 CI/CD 的本地开发
- 不需要自动部署的项目
- 原型开发和实验

## Setup

```yaml
# project.yaml
adapters:
  ci:
    type: "noop"
```

无需配置。所有方法立即返回成功。

## 行为

- `trigger()` → 返回 `{ runId: "noop-1", status: "success" }`
- `getStatus()` → 始终返回 `"success"`
- `waitForCompletion()` → 立即返回
- `listPipelines()` → 返回空列表