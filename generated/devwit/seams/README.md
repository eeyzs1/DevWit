# Capability Seams (Fusion Plan v3 — A-WU3)

Borrowed from DeepSeek Harness's capability-seam model: every swappable
capability is TRI-PARTITE, and one role alone is not a seam. Swapping a
provider is a configuration/composition change, never a consumer edit.

| Role | Meaning | Location |
|---|---|---|
| **Definition** | The seam's interface contract | `seams/<name>/definition.yaml` |
| **Provider(s)** | Concrete implementations, registered by name | `seams/<name>/providers/`（或既有适配器路径） |
| **Consumer(s)** | Code that calls ONLY the interface, never a backend | `seams/<name>/consumers/`（或既有消费方路径） |

Rules:
- A seam is complete only when all three roles exist (validate-harness check [11]).
- Seams covered here: `workitem-source`, `executor`, `ci`, `sandbox`.
- 本目录由 meta-harness v3.0 同步（2026-08-28），与 Fusion Plan v3 层面 A 对应。
