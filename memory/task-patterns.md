# Task Patterns

## Purpose
Catalog patterns of tasks that the meta-harness has seen.
When a new task arrives, the interpreter can match it to known patterns
and generate a better harness faster.

## Format
```
### Pattern: [Name]
- Domain: [primary domain]
- Signals: [keywords/phrases that indicate this pattern]
- Template: [which template to use]
- Typical topology: [agent topology pattern]
- Common pitfalls: [what usually goes wrong with this type of task]
- Success rate: [historical success rate, if available]
```

## Known Patterns

### Pattern: CRUD Application
- Domain: software_development
- Signals: "manage", "track", "list", "add/edit/delete", "dashboard"
- Template: web-app
- Typical topology: planner-executor
- Common pitfalls: over-engineering, premature optimization, missing validation

### Pattern: Data Sync/ETL
- Domain: data_processing
- Signals: "sync", "import", "export", "migrate", "transform", "ETL"
- Template: data-pipeline
- Typical topology: pipeline
- Common pitfalls: data loss, schema drift, missing error handling

### Pattern: Monitoring/Alerting
- Domain: automation
- Signals: "monitor", "alert", "notify", "watch", "detect"
- Template: automation
- Typical topology: planner-executor
- Common pitfalls: alert fatigue, missing edge cases, no manual override

### Pattern: Content Generation
- Domain: content_generation
- Signals: "write", "generate", "create content", "blog", "report"
- Template: content-system
- Typical topology: three-agent (researcher/writer/editor)
- Common pitfalls: hallucination, style inconsistency, missing fact-check
