PHASE_START
Phase: {{N}} of {{TOTAL}} — {{NAME}}
Task: {{ONE_LINE_TASK}}
Type: {{TYPE}}
Mandatory commands: {{COMMANDS}}
Acceptance criteria: {{COUNT}}
Evidence required: {{EVIDENCE_TYPES}}
Skills: {{SKILLS}}
Depends on phases: {{DEPS}}

## Scope (文件修改边界 — 见 seeds/verification/scope-fence.md)

### Allowed (可修改)
- {{ALLOWED_FILE_1}}
- {{ALLOWED_FILE_2}}

### Read-Only Reference (可阅读，不可修改)
- {{REFERENCE_FILE_1}}
- {{REFERENCE_FILE_2}}

### Forbidden (禁止触碰)
- {{FORBIDDEN_PATH_1}}/

## Work Description

{{DETAILED_WORK_DESCRIPTION}}

## Context Summary (大项目关键 — 只包含本 Phase 相关上下文)

### {{KEY_FILE_1}} (需要修改)
- `{{KEY_FUNCTION}}` — {{WHAT_IT_DOES}}
- 依赖: {{DEPENDENCIES}}

### {{KEY_FILE_2}} (只读参考)
- `{{TYPE_OR_INTERFACE}}` — {{DESCRIPTION}}

## Acceptance Criteria

1. {{CRITERION_1}}
2. {{CRITERION_2}}
3. {{CRITERION_3}}
...

## Deliverables

- {{DELIVERABLE_1}}
- {{DELIVERABLE_2}}
...

## Mandatory Commands

- build: `{{BUILD_COMMAND}}`
- typecheck: `{{TYPECHECK_COMMAND}}`
- lint: `{{LINT_COMMAND}}`
- test: `{{TEST_COMMAND}}`

## Evidence Required

- {{EVIDENCE_TYPE_1}}: {{WHAT_TO_CAPTURE}}
- {{EVIDENCE_TYPE_2}}: {{WHAT_TO_CAPTURE}}
...

## Notes

{{ADDITIONAL_NOTES}}

---

[Agent will print PHASE_VERIFY and PHASE_DONE here during execution]