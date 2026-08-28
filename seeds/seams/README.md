# Capability Seams (WP8)

Borrowed from DSH's capability-seam model: every swappable capability is
TRI-PARTITE, and one role alone is not a seam.

| Role | Meaning | Location |
|---|---|---|
| **Definition** | The seam's interface contract | `seams/<name>/definition.yaml` |
| **Provider(s)** | Concrete implementations, registered by name | `seams/<name>/providers/*.py` |
| **Consumer(s)** | Code that calls ONLY the interface, never a backend | `seams/<name>/consumers/*.py` |

Rules:
- A seam is complete only when all three roles exist (validate-harness enforces it).
- Swapping a provider is a configuration/composition change, never a consumer edit.
- Seams covered here: `workitem-source`, `executor`, `ci`, `sandbox`.
  Existing adapter docs (e.g. `tools/adapters/executor-*.md`) are the reference
  contracts these seams formalize.
