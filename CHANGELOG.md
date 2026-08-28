# Changelog

All notable changes to Meta-Harness are documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/), adheres to
[Semantic Versioning](https://semver.org/).

## [3.0.0] — 2026-08-28

### Added — DSH-inspired core concepts (event log, invariants, goals, hooks)

- **Append-only phase event log + projection**: `meta/event-log.yaml` is the
  single source of truth; `meta/pipeline-state.yaml` and
  `.meta-harness/PHASE_BRIEF.md` are derived projections with an `asOfSeq`
  watermark (model-visible ⟺ logged). `scripts/state_fold.py` owns the pure
  fold + CAS append + legacy migration (`seed/import`).
- **Fail-closed invariants**: `scripts/log_invariant.py` refuses unknown log
  versions/event types, seq gaps, stale state/brief watermarks, and orphaned
  compactions (stable codes, e.g. `INVARIANT_STALE_BRIEF`).
- **Goal semantics**: `--unblock --code <code> --reason <reason>` records WHY;
  blocked only after 3 consecutive refusals with the SAME code; `rounds /
  max_rounds` bound auto-continuation; `--pause` / `--resume`; `--events` dump.
- **Hooks (bail gate + observers)**: `hooks/pre-advance/*.py` can refuse an
  advance with a stable code (the GENERATE→FACTORY validate-harness gate moved
  here); `hooks/phase-complete|phase-enter` are contained observers.
  `scripts/events.py` provides emit/serial/bail/parallel/waterfall helpers.
- **Composition manifest + patches**: generated projects ship
  `harness-composition.yaml` (named rows) + optional `harness-patch.yaml`
  (override by id; unknown ids refused). `scripts/compose.py` merges;
  `validate-harness.py` check [10]; generated `orchestrator.py --verify` runs
  only enabled `runner=orchestrator` rows.
- **Skill catalog + loader**: generated projects ship `skills/catalog.yaml`;
  `context/loader.py skill list|load` lists broken skills with reasons.
- **Compaction + spill**: `--compact` regenerates the brief with
  `compaction/start/summary/end` lock markers (orphans detected); `scripts/spill.py`
  persists oversized text to `meta/artifacts/` with a locator, best-effort.
- **Postmortems**: `memory/postmortems/NNNN-<slug>.md` written by
  `feedback/mistake-to-constraint.py` (what broke / root cause / why it escaped
  / durable lesson), idempotent, linked to `mistake/recorded` events.
- **Capability seams**: generated projects ship `seams/`
  (workitem-source/executor/ci/sandbox); validate-harness check [11] rejects
  PARTIAL seams and configured-but-missing adapters.
- **Permission model**: `tools/permissions.yaml` v2 adds explicit modes
  (read-only/workspace-write/full) + presets; `guard.py --permission` is a
  monotonic chain (denial final, exit 126); `tools/enforce-permission.py`
  separates "sandbox denied" (126) from "task failed" (runner exit code).
- **Evolution hardening**: `scripts/evolve.py` adds evidence_refs on every
  mutation, pre-mutation snapshots + `--rollback` + `--list-snapshots`,
  approval tiers (`AUTO` vs `NEEDS_APPROVAL`), and versioned `generations`.
- **Doc budgets**: `scripts/verify_doc_budgets.py` (line budgets + single-home
  duplicate-fact warnings), wired into validate-harness check [12] as WARN.
- **Tests**: `tests/test_state_fold.py`, `test_orchestrator.py`,
  `test_compose.py`, `test_events.py`, `test_integration.py` — every new gate
  ships a regression test that fails without it.

### Changed
- `meta/meta-orchestrator.py` is now event-driven: all mutations append events
  with compare-and-set; `--status`/`--next`/`--advance` behavior preserved.
- `seeds/orchestrator.py` (generated projects) uses `memory/event-log.yaml`
  with `memory/session-state.yaml` as a derived projection.
- `tests/test_pipeline.py::test_all_layers_present` fixed: the Layer Test task
  now uses a full complexity profile so ARTIFACT_GATE-gated artifacts
  (human-interface/audit-log/session-replay) are copied.
- AGENTS.md / README.md / META.md updated for the v3.0 architecture.

## [2.5.0] — 2026-06-24

### Added
- **S/C/N/K 复杂度模型**: `scripts/interpret.py` 新增 `classify_complexity()`，
  从 intent 推导四个正交因子（Scope/Criticality/Novelty/Coupling，每因子 1-5）
  与 tier（minimal/standard/full），替代伪概念 "difficulty"。写入 `task.complexity`。
- **ARTIFACT_GATE**: `scripts/generate.py` 新增按因子谓词裁剪 artifact 的机制
  （verification/observability/feedback/security 四层），`copy_seed_artifacts()`
  按 profile 过滤；`write_harness_profile()` 写运行时契约 `harness-profile.yaml`。
- **preseed_long_term**: `scripts/generate.py` 按 Novelty 因子差异化预填
  `memory/long-term/`（N≥3 预填 `known-patterns.yaml` + `anti-patterns.yaml`，
  来自 `domain-advancements.yaml` 的 `stage_to_novelty` 映射）。
- **知识库四职能模型**: `seeds/context/loader.py` 重写为 inject / retrieve /
  active_constraints / recall 四职能。retrieve 用三信号加权排序
  （path-prefix +3 / domain-tag +2 / keyword overlap +1）替代布尔匹配，
  含停用词过滤。
- **prototypes 角色原型**: `seeds/planning/sub-agent-dispatch.yaml` v2 格式，
  6 角色原型带 `condition` / `count` 表达式，按 S/C/N/K 实例化。
- **agent-factory 自适应拓扑**: `scripts/agent-factory.py` 新增 `derive_roles()`
  按 prototype 实例化 + `compute_context_budget()` 按 S/N 推导上下文预算。
- **knowledge-index v2**: `seeds/context/knowledge-index.yaml` 每条 mapping
  带 description + 受控词表 tags。
- **stage_to_novelty 映射**: `seeds/evolution/domain-advancements.yaml` 追加
  进阶阶段到 Novelty 因子的映射（Basic=1/Solid=3/Advanced=4/Excellent=5）。

### Changed
- 生成 harness 的大小现在按任务复杂度自适应（minimal/standard/full 三档），
  替代原固定全量复制。
- 高 Novelty 项目自带预填知识库，替代原空 `memory/long-term/`。
- `meta/harness-generator.md` 文档更新：替换 CONCEPTUAL 概念为已实现的
  S/C/N/K 模型 + ARTIFACT_GATE。

### Backward Compatible
- 旧 `task.yaml` 无 `complexity` 字段时默认 `{S:3,C:3,N:3,K:3,standard}`，
  复制行为 ≈ 原全量复制。
- `loader.py` 自动包装 v1 字符串值为 v2 dict。
- `sub-agent-dispatch.yaml` 无 `prototypes` 时回退 `roles`。

## [2.4.0] — 2026-06-22

### Added
- **`--interpret-intent` flag** on `meta/meta-orchestrator.py`: scripted INTERPRET
  entry point. Runs `scripts/interpret.py` on a raw intent string, writes
  `task.yaml`, and locks the resulting acceptance criteria in one command.
- **`--advance` auto-run**: `--advance` now automatically executes the next
  phase's script after advancing (generate.py / agent-factory.py /
  verify-generation.py / judge.py / evolve.py). The pipeline can now run
  end-to-end with a chain of `--advance` calls.
- **`--no-auto-run` flag**: skips auto-execution when you want to run phase
  scripts manually (restores pre-2.4 `--advance` behavior).
- **`scripts/agent-factory.py`**: scripted FACTORY phase. Reads task.yaml +
  planning configs, generates per-role agent configs + topology YAML.
- **`scripts/judge.py`**: scripted JUDGE phase. Reads acceptance criteria +
  session-state, produces verdict (PROVEN / NOT_PROVEN / INSUFFICIENT_EVIDENCE)
  with exit codes (0 / 1 / 2).
- **interpret.py deepening**: quality-attribute extraction, explicit constraint
  extraction (must / must not / forbidden), explicit acceptance-criteria
  extraction, unknowns derived from missing info, assumptions derived from
  classification evidence. New output fields: `quality_attributes`,
  `hard_constraints`, `soft_constraints`.
- **evolve.py context-awareness**: detects meta-harness vs generated-project
  context. In generated projects, reads `memory/session-state.yaml` for
  `completed_criteria` and `guard_log` verification failures.
- **evolve.py substantive mutations**: ADD_CONSTRAINT generates concrete rules
  from evidence; STRENGTHEN_CONSTRAINT appends verification enforcement;
  WEAKEN_CONSTRAINT downgrades "must" to "should".

### Changed
- **`--advance` behavior** (BREAKING): now auto-runs the next phase script.
  Use `--no-auto-run` to restore the old manual behavior.
- **`consistency-check.py` scan scope** (BREAKING): now scans only `src/`
  instead of the entire project tree. Prevents false positives on the harness's
  own scripts. Projects without `src/` get a warning instead of a full scan.
- **`harness-generator.md` documentation**: `project.yaml`, `phase-activation.yaml`,
  `STATE.md`, `ROADMAP.md`, `skills/` directory now marked as CONCEPTUAL
  (design targets not yet auto-generated). Output Structure tree updated to
  match what `generate.py` actually emits.
- **`interpret.py` output structure**: added `quality_attributes`,
  `hard_constraints`, `soft_constraints` fields. Existing fields unchanged
  (backward compatible).

### Fixed
- **entropy-reduction.py argument bug** (BLOCKING): `orchestrator.py` passed
  `--check-only` but the script only accepts `--dry-run` / `--fix`. This caused
  `--verify` to always fail → `--mark-complete` always rejected → acceptance
  criteria could never complete. Fixed to pass `--dry-run`.
- **evolve.py path bug**: evolve.py only worked in the meta-harness context
  (read `meta/pipeline-state.yaml`). In generated projects it found no evidence
  and proposed no mutations. Fixed with context detection.
- **evolve.py superficial mutations**: mutations appended text labels
  ("(strengthened)") instead of modifying constraint logic. Fixed to make
  substantive rule changes.
- **`.cursorrules` generation**: `generate.py` now emits `.cursorrules`
  (redirect to AGENTS.md) so Cursor users get automatic rule loading.
- **`rmtree` safety**: `generate.py` writes a `.harness-generated` marker file
  and refuses to delete directories without it. Prevents accidental data loss.
- **`verify-generation.py` syntax check**: now uses `py_compile` for real
  syntax validation instead of just checking file existence.
- **`force_phase` stale evidence**: `--force-phase` now resets
  `verified_criteria` so stale evidence from a prior run doesn't mislead.
- **`verify_criterion` whitespace matching**: criteria matching now normalizes
  whitespace so YAML round-trip differences don't break verification.

### Upgrade Guide

1. Run `powershell scripts/check-version.ps1` (Windows) or
   `bash scripts/check-version.sh` (Linux/Mac) to confirm update is available.
2. Run `powershell scripts/update-harness.ps1` (Windows) or
   `bash scripts/update-harness.sh` (Linux/Mac) to update.
3. **If you have an in-progress pipeline**, reset it:
   `python meta/meta-orchestrator.py --reset`
4. **If you rely on manual `--advance` behavior** (no auto script execution),
   add `--no-auto-run` to your `--advance` calls.
5. **If you have downstream scripts parsing `task.yaml`**, they will still work
   — new fields (`quality_attributes`, `hard_constraints`, `soft_constraints`)
   are additive. Strict-schema validators may need updating.

## [2.3.0] — 2026-06 (initial structured release)

- 6-phase pipeline: INTERPRET → GENERATE → FACTORY → PROVE → JUDGE → EVOLVE
- PHASE_BRIEF.md context-loss recovery mechanism
- Acceptance criteria locking for task-drift prevention
- 7-layer + 2 cross-cutting + self-evolution architecture
- Domain templates: web-app, api-service, automation, data-pipeline, content-system
- Version check + self-update scripts (Windows + Linux/Mac)
