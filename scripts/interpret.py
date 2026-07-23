#!/usr/bin/env python3
"""
Interpreter: Intent → Structured Task Definition (First Principles)

Parses a raw intent string and produces a structured task definition
following the interpreter.md specification. This is the first step
of the compilation pipeline.

Deepening (v2.4):
  - Quality attribute extraction from intent (performance, security, ...)
  - Explicit constraint extraction (must / must not / required / forbidden)
  - Explicit acceptance-criteria extraction (user-stated "must support X")
  - Domain criteria merged with explicit criteria (deduped)
  - Unknowns derived from what the intent does NOT state (stack, auth, deploy)
  - write_task_file() helper for meta-orchestrator integration

Usage:
    python scripts/interpret.py --intent "I need a customer onboarding system"
    python scripts/interpret.py --intent-file intent.txt
    python scripts/interpret.py --intent "..." --output task.yaml
"""

import argparse
import re
import sys
from pathlib import Path

import yaml

DOMAIN_KEYWORDS = {
    "web-app": ["web app", "website", "frontend", "ui", "dashboard", "portal", "landing page", "spa"],
    "api-service": ["api", "rest", "graphql", "backend", "microservice", "endpoint", "server"],
    "automation": ["automate", "schedule", "cron", "workflow", "trigger", "monitor", "alert", "bot"],
    "data-pipeline": ["data pipeline", "etl", "ingest", "transform", "analytics", "warehouse", "batch"],
    "content-system": ["content", "blog", "cms", "publish", "article", "document", "newsletter"],
}

SCALE_KEYWORDS = {
    "personal": ["personal", "my", "i need", "simple", "just me"],
    "team": ["team", "our", "we need", "group", "department"],
    "organization": ["company", "organization", "enterprise", "everyone", "all employees"],
    "public": ["public", "users", "customers", "saas", "marketplace"],
}

# Quality attribute detection: maps keyword groups to attribute names.
QUALITY_ATTRIBUTE_KEYWORDS = {
    "performance": ["fast", "performance", "latency", "throughput", "responsive", "quick", "speed", "real-time", "realtime"],
    "security": ["secure", "security", "auth", "authentication", "authorization", "encryption", "gdpr", "compliance", "pci"],
    "scalability": ["scale", "scalable", "scalability", "high-availability", "ha", "cluster", "distributed", "horizontal"],
    "reliability": ["reliable", "reliability", "fault-tolerant", "resilient", "robust", "uptime", "sla"],
    "observability": ["monitor", "monitoring", "logging", "tracing", "metrics", "alerting", "dashboard"],
    "usability": ["usable", "usability", "accessible", "accessibility", "intuitive", "user-friendly", "a11y"],
    "maintainability": ["maintainable", "maintainability", "testable", "modular", "clean", "documented"],
    "cost": ["cheap", "low-cost", "budget", "cost-effective", "affordable", "free-tier"],
}

# Explicit constraint extraction: sentences/phrases stating hard rules.
CONSTRAINT_PATTERNS = [
    # "must not use X", "cannot use X", "no X allowed"
    (re.compile(r"(?:must not|cannot|can't|no)\s+use\s+(.+?)(?:[.;]|$)", re.IGNORECASE), "forbidden-tech"),
    (re.compile(r"(?:must not|cannot|can't)\s+(.+?)(?:[.;]|$)", re.IGNORECASE), "must-not"),
    (re.compile(r"(?:must|shall|required to)\s+(.+?)(?:[.;]|$)", re.IGNORECASE), "must"),
    (re.compile(r"(?:forbidden|prohibited|banned)\s*:\s*(.+?)(?:[.;]|$)", re.IGNORECASE), "forbidden"),
    (re.compile(r"(?:only|exclusively)\s+(?:use|support)\s+(.+?)(?:[.;]|$)", re.IGNORECASE), "only"),
]

# Explicit acceptance-criteria extraction: user-stated outcomes.
CRITERIA_PATTERNS = [
    re.compile(r"(?:must|should|need to|needs to|has to)\s+(?:support|allow|enable|provide|handle|be able to)\s+(.+?)(?:[.;]|$)", re.IGNORECASE),
    re.compile(r"(?:users?|customers?|system)\s+(?:should|must|will)\s+(?:be able to|be capable of)\s+(.+?)(?:[.;]|$)", re.IGNORECASE),
    re.compile(r"(?:support|supports|handle|handles)\s+(.+?)(?:[.;]|$)", re.IGNORECASE),
]


def classify_domain(intent: str) -> str:
    intent_lower = intent.lower()
    scores = {}
    for domain, keywords in DOMAIN_KEYWORDS.items():
        scores[domain] = sum(1 for kw in keywords if kw in intent_lower)
    best = max(scores, key=scores.get)
    return best if scores[best] > 0 else "web-app"


def classify_scale(intent: str) -> str:
    intent_lower = intent.lower()
    for scale, keywords in SCALE_KEYWORDS.items():
        if any(kw in intent_lower for kw in keywords):
            return scale
    return "team"


def extract_goal(intent: str) -> str:
    goal = intent.strip()
    prefixes = ["i need ", "i want ", "build ", "create ", "make ", "help me "]
    for prefix in prefixes:
        if goal.lower().startswith(prefix):
            goal = goal[len(prefix):].strip()
    return goal[0].upper() + goal[1:] if goal else "Complete the task"


def extract_quality_attributes(intent: str) -> list:
    """Detect quality attributes mentioned in the intent."""
    intent_lower = intent.lower()
    found = []
    for attr, keywords in QUALITY_ATTRIBUTE_KEYWORDS.items():
        if any(kw in intent_lower for kw in keywords):
            found.append(attr)
    return found


def extract_explicit_constraints(intent: str) -> tuple:
    """Extract hard and soft constraints explicitly stated in the intent.

    Returns (hard_constraints, soft_constraints) as lists of strings.
    """
    hard = []
    soft = []
    for pattern, kind in CONSTRAINT_PATTERNS:
        for match in pattern.finditer(intent):
            text = match.group(0).strip().rstrip(".;")
            if kind in ("must", "only"):
                hard.append(text)
            elif kind in ("must-not", "forbidden", "forbidden-tech"):
                hard.append(text)
            else:
                soft.append(text)
    # Dedupe while preserving order.
    hard = list(dict.fromkeys(hard))
    soft = list(dict.fromkeys(soft))
    return hard, soft


def extract_explicit_criteria(intent: str) -> list:
    """Extract acceptance criteria explicitly stated by the user.

    These override/supplement the domain-template criteria because they
    represent the user's actual stated outcomes, not generic defaults.
    """
    found = []
    for pattern in CRITERIA_PATTERNS:
        for match in pattern.finditer(intent):
            raw = match.group(1).strip().rstrip(".;")
            # Capitalize the captured outcome as a capability statement.
            criterion = raw[0].upper() + raw[1:] if raw else raw
            found.append(criterion)
    # Dedupe while preserving order.
    return list(dict.fromkeys(found))


def generate_acceptance_criteria(intent: str, domain: str) -> list:
    """Combine domain-template criteria with user-stated explicit criteria.

    Explicit criteria (stated by the user) come FIRST because they reflect
    actual intent; domain-template criteria follow as sensible defaults
    the user may not have thought to state.
    """
    explicit = extract_explicit_criteria(intent)

    template_criteria = {
        "api-service": [
            "API endpoints respond with correct status codes",
            "Input validation rejects invalid requests",
            "Error responses follow consistent format",
            "API documentation is auto-generated",
        ],
        "web-app": [
            "Users can complete the primary workflow end-to-end",
            "UI is responsive on mobile and desktop",
            "Authentication works correctly",
            "Build succeeds with no errors",
        ],
        "automation": [
            "Automation triggers correctly on events",
            "Actions produce expected results",
            "Error handling works (simulate failures)",
            "Manual override is available",
        ],
        "data-pipeline": [
            "Data is ingested without loss",
            "Transformations produce correct output",
            "Error records are quarantined, not dropped",
            "Pipeline completes within time budget",
        ],
        "content-system": [
            "Content follows style guide",
            "Review step catches quality issues",
            "Metadata is complete before publication",
            "Version history is maintained",
        ],
    }
    domain_criteria = template_criteria.get(domain, template_criteria["web-app"])

    # Merge: explicit first, then domain defaults that aren't already covered.
    # Dedupe by lowercase comparison so paraphrases don't double up.
    seen = {c.lower() for c in explicit}
    merged = list(explicit)
    for c in domain_criteria:
        if c.lower() not in seen:
            merged.append(c)
            seen.add(c.lower())
    return merged


def derive_unknowns(intent: str, domain: str, scale: str, quality_attrs: list) -> list:
    """Derive unknowns from what the intent does NOT state.

    Rather than a static list, surface gaps based on domain/scale/quality
    signals actually present in the intent.
    """
    intent_lower = intent.lower()
    unknowns = []

    # Tech stack: only flag as unknown if not mentioned.
    stack_terms = ["python", "javascript", "typescript", "node", "react", "vue", "go", "rust", "java", "c#", ".net", "fastapi", "django", "flask", "express"]
    if not any(t in intent_lower for t in stack_terms):
        unknowns.append("Exact technical stack preference")

    # Auth: flag unless explicitly mentioned.
    if not any(t in intent_lower for t in ["auth", "login", "sso", "oauth", "jwt", "session"]):
        unknowns.append("Authentication method")

    # Deployment: flag unless explicitly mentioned.
    if not any(t in intent_lower for t in ["deploy", "docker", "kubernetes", "k8s", "aws", "gcp", "azure", "cloud", "on-prem", "serverless"]):
        unknowns.append("Deployment target")

    # Data storage: relevant for most domains except pure content/automation.
    if domain in ("web-app", "api-service", "data-pipeline") and not any(
        t in intent_lower for t in ["database", "postgres", "mysql", "mongo", "redis", "sql", "dynamodb", "sqlite"]
    ):
        unknowns.append("Data storage choice")

    # Scale numbers: if scale is organization/public but no numbers given.
    if scale in ("organization", "public") and not re.search(r"\d+\s*(?:user|customer|request|qps|rps|record|row)", intent_lower):
        unknowns.append(f"Expected user/load volume for {scale} scale")

    # Security compliance: if security mentioned but no specific standard.
    if "security" in quality_attrs and not any(t in intent_lower for t in ["gdpr", "pci", "hipaa", "soc2", "iso27001"]):
        unknowns.append("Specific security/compliance standard required")

    return unknowns if unknowns else ["No specific unknowns detected — confirm assumptions with user"]


# 复杂度因子词表（第一性原理：difficulty 是伪概念，拆为 S/C/N/K 四正交因子）
HIGH_COST_WORDS = [
    "payment", "prod", "production", "delete", "migrate", "migration",
    "security", "auth", "money", "deploy", "release", "付费", "生产",
    "删除", "迁移", "上线", "支付",
]
LOW_COST_WORDS = ["test", "demo", "prototype", "sandbox", "试验", "原型", "示例"]
COUPLING_WORDS = [
    "integrate", "integration", "refactor", "migration", "cross", "shared",
    "contract", "sync", "集成", "重构", "跨", "共享", "联调",
]
GREENFIELD_WORDS = ["greenfield", "from scratch", "全新", "new project", "blank slate"]
# 框架/版本模式：用于 Novelty 因子判断 hard_constraints 是否提及具体技术栈
FRAMEWORK_PATTERN = re.compile(
    r"(react|vue|angular|svelte|next|nuxt|fastapi|django|flask|express|"
    r"spring|rails|gin|echo|actix|tokio|graphql|grpc|kafka|redis|"
    r"postgres|mysql|mongo|elasticsearch|kubernetes)"
    r"|\b[\w.-]+\s*\d+\.\d+\b",
    re.IGNORECASE,
)


def _domain_match_score(intent: str) -> int:
    """返回 intent 与所有 domain 关键词的最高匹配数（用于判断 domain 置信度）。"""
    intent_lower = intent.lower()
    scores = [sum(1 for kw in keywords if kw in intent_lower)
              for keywords in DOMAIN_KEYWORDS.values()]
    return max(scores) if scores else 0


def _clamp(value: int, low: int = 1, high: int = 5) -> int:
    return max(low, min(high, value))


def classify_complexity(intent: str, domain: str, scale: str, quality_attrs: list,
                        hard_constraints: list, acceptance_criteria: list) -> dict:
    """从第一性原理推导任务的四个正交复杂度因子与派生 tier。

    difficulty 是伪概念，拆为 S/C/N/K 四正交因子：
      - Scope (S): 独立关注点数 → 驱动 agent 数、上下文预算
      - Criticality (C): 失效代价 → 驱动验证严格度、人工 gate
      - Novelty (N): 距训练分布/已积累知识 → 驱动知识库质量
      - Coupling (K): 跨组件咬合度 → 驱动一致性检查、架构规则
    每因子 1-5。tier 为粗粒度层裁剪派生量。
    """
    intent_lower = intent.lower()
    goal = extract_goal(intent)
    constraint_text = " ".join(hard_constraints or []).lower()

    # --- Scope (S): 独立关注点数 ---
    # 前 3 条准则是领域模板基线，不计入额外 scope；超过的才代表更多关注点
    conjunctions = len(re.findall(r"\band\b|\+|和|以及|同时", goal, re.IGNORECASE))
    scale_weight = {"personal": 0, "team": 1, "organization": 2, "public": 2}.get(scale, 1)
    criteria_count = len(acceptance_criteria) if acceptance_criteria else 0
    extra_criteria = max(0, criteria_count - 3)
    scope = _clamp(1 + conjunctions + scale_weight + int(extra_criteria * 0.5))

    # --- Criticality (C): 失效代价（不可逆性 × 爆炸半径） ---
    criticality = 1
    for w in HIGH_COST_WORDS:
        if w in intent_lower or w in constraint_text:
            criticality += 2
    for w in LOW_COST_WORDS:
        if w in intent_lower or w in constraint_text:
            criticality -= 1
    criticality = _clamp(criticality)

    # --- Novelty (N): 距训练分布/已积累知识 ---
    # domain 低置信度（匹配分低）→ 任务可能不在常见领域 → novelty 高
    # 注意：match_score==0 也可能源于关键词表不全，故保守 +1（非 +2）
    novelty = 1
    match_score = _domain_match_score(intent)
    if match_score == 0:
        novelty += 1  # 无任何 domain 关键词命中，可能是陌生领域
    elif match_score == 1:
        novelty += 1  # 弱匹配
    # hard_constraints 提及具体框架/版本 → 技术栈明确但可能不常见 → +1/条（最多 +2）
    framework_hits = 0
    for hc in (hard_constraints or []):
        if FRAMEWORK_PATTERN.search(str(hc)):
            framework_hits += 1
    novelty += min(2, framework_hits)
    novelty = _clamp(novelty)

    # --- Coupling (K): 跨组件咬合度 ---
    # 用 in 子串匹配（\b 词边界对中文无效）
    coupling = 2
    combined_text = intent_lower + " " + constraint_text
    coupling_hits = sum(1 for w in COUPLING_WORDS if w in combined_text)
    coupling += min(3, coupling_hits)
    for w in GREENFIELD_WORDS:
        if w in intent_lower:
            coupling -= 1
            break
    coupling = _clamp(coupling)

    # --- tier: 粗粒度层裁剪派生量 ---
    if scope <= 2 and criticality <= 2 and novelty <= 2 and coupling <= 2:
        tier = "minimal"
    elif scope >= 4 or criticality >= 4 or novelty >= 4:
        tier = "full"
    else:
        tier = "standard"

    return {
        "scope": scope,
        "criticality": criticality,
        "novelty": novelty,
        "coupling": coupling,
        "tier": tier,
    }


def derive_assumptions(intent: str, domain: str, scale: str, quality_attrs: list, hard_constraints: list) -> list:
    """Derive assumptions from the classification evidence."""
    assumptions = [
        f"Domain classified as {domain} based on intent keywords",
        f"Scale classified as {scale} based on intent keywords",
    ]
    if quality_attrs:
        assumptions.append(f"Quality attributes prioritized: {', '.join(quality_attrs)} (inferred from intent)")
    else:
        assumptions.append("No explicit quality attributes stated — defaulting to correctness + maintainability")
    if hard_constraints:
        assumptions.append(f"{len(hard_constraints)} hard constraint(s) extracted from intent text")
    assumptions.append("Acceptance criteria are initial suggestions — user should refine during INTERPRET confirmation")
    return assumptions


def interpret_intent(intent: str) -> dict:
    domain = classify_domain(intent)
    scale = classify_scale(intent)
    goal = extract_goal(intent)
    quality_attrs = extract_quality_attributes(intent)
    hard_constraints, soft_constraints = extract_explicit_constraints(intent)
    criteria = generate_acceptance_criteria(intent, domain)
    unknowns = derive_unknowns(intent, domain, scale, quality_attrs)
    assumptions = derive_assumptions(intent, domain, scale, quality_attrs, hard_constraints)
    complexity = classify_complexity(intent, domain, scale, quality_attrs,
                                     hard_constraints, criteria)

    task = {
        "name": goal[:80],
        "domain": domain.replace("-", "_"),
        "real_need": intent.strip(),
        "goal": goal,
        "scale": scale,
        "complexity": complexity,
        "quality_attributes": quality_attrs,
        "hard_constraints": hard_constraints,
        "soft_constraints": soft_constraints,
        "acceptance_criteria": criteria,
        "unknowns": unknowns,
        "assumptions": assumptions,
    }
    return task


def write_task_file(task: dict, output_path: Path) -> None:
    """Write the task definition to a YAML file (used by meta-orchestrator)."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        yaml.dump(task, f, default_flow_style=False, allow_unicode=True, sort_keys=False)


def main():
    parser = argparse.ArgumentParser(description="Meta-Harness Interpreter")
    parser.add_argument("--intent", default=None, help="Raw intent string")
    parser.add_argument("--intent-file", default=None, help="File containing raw intent")
    parser.add_argument("--output", default=None, help="Output task definition file (YAML)")
    args = parser.parse_args()

    if args.intent:
        intent = args.intent
    elif args.intent_file:
        intent_file = Path(args.intent_file)
        if not intent_file.exists():
            print(f"ERROR: Intent file not found: {intent_file}")
            sys.exit(1)
        intent = intent_file.read_text(encoding="utf-8").strip()
    else:
        print("ERROR: Provide --intent or --intent-file")
        sys.exit(1)

    task = interpret_intent(intent)

    output = yaml.dump(task, default_flow_style=False, allow_unicode=True, sort_keys=False)

    if args.output:
        write_task_file(task, Path(args.output))
        print(f"Task definition written to: {args.output}")
        print(f"  Domain: {task['domain']}")
        print(f"  Scale: {task['scale']}")
        cx = task.get("complexity", {})
        print(f"  Complexity: tier={cx.get('tier')} S={cx.get('scope')} "
              f"C={cx.get('criticality')} N={cx.get('novelty')} K={cx.get('coupling')}")
        print(f"  Quality attributes: {task['quality_attributes']}")
        print(f"  Hard constraints: {len(task['hard_constraints'])}")
        print(f"  Acceptance criteria: {len(task['acceptance_criteria'])}")
    else:
        print(output)


if __name__ == "__main__":
    main()
