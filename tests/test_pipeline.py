#!/usr/bin/env python3
"""
Test suite for the Meta-Harness generation pipeline.

Run: python -m pytest tests/ -v
"""

import json
import shutil
import tempfile
from pathlib import Path

import yaml
import pytest

HARNESS_ROOT = Path(__file__).resolve().parent.parent
sys_path_hack = str(HARNESS_ROOT / "scripts")

import sys
if sys_path_hack not in sys.path:
    sys.path.insert(0, sys_path_hack)


class TestTaskValidation:
    def test_valid_task(self):
        from generate import validate_task
        task = {"name": "Test", "domain": "api_service", "goal": "Build an API"}
        errors = validate_task(task)
        assert len(errors) == 0

    def test_missing_required_fields(self):
        from generate import validate_task
        task = {"name": "Test"}
        errors = validate_task(task)
        assert len(errors) >= 2
        assert any("domain" in e for e in errors)
        assert any("goal" in e for e in errors)

    def test_empty_name(self):
        from generate import validate_task
        task = {"name": "", "domain": "api", "goal": "Build"}
        errors = validate_task(task)
        assert any("name" in e for e in errors)

    def test_wrong_type_for_array(self):
        from generate import validate_task
        task = {"name": "Test", "domain": "api", "goal": "Build", "acceptance_criteria": "not a list"}
        errors = validate_task(task)
        assert any("acceptance_criteria" in e for e in errors)


class TestTemplateDetection:
    def test_api_service(self):
        from generate import detect_template
        assert detect_template({"domain": "api_service"}) == "api-service"

    def test_web_app(self):
        from generate import detect_template
        assert detect_template({"domain": "web_app"}) == "web-app"

    def test_automation(self):
        from generate import detect_template
        assert detect_template({"domain": "automation"}) == "automation"

    def test_data_pipeline(self):
        from generate import detect_template
        assert detect_template({"domain": "data_pipeline"}) == "data-pipeline"

    def test_unknown_defaults_to_web_app(self):
        from generate import detect_template
        assert detect_template({"domain": "unknown_thing"}) == "web-app"


class TestTemplateParsing:
    def test_parse_api_service_template(self):
        from generate import parse_template
        template_file = HARNESS_ROOT / "templates" / "api-service" / "template.md"
        if not template_file.exists():
            pytest.skip("api-service template not found")
        result = parse_template(template_file)
        assert len(result["constraints"]) > 0
        assert len(result["workflows"]) > 0
        assert len(result["verification_checklist"]) > 0

    def test_parse_web_app_template(self):
        from generate import parse_template
        template_file = HARNESS_ROOT / "templates" / "web-app" / "template.md"
        if not template_file.exists():
            pytest.skip("web-app template not found")
        result = parse_template(template_file)
        assert len(result["constraints"]) > 0
        assert len(result["workflows"]) > 0

    def test_parse_nonexistent_template(self):
        from generate import parse_template
        result = parse_template(Path("/nonexistent/template.md"))
        assert result["constraints"] == []


class TestGeneration:
    @pytest.fixture
    def temp_output(self):
        tmp = tempfile.mkdtemp(prefix="harness_test_")
        yield Path(tmp)
        shutil.rmtree(tmp, ignore_errors=True)

    def test_generate_api_service(self, temp_output):
        from generate import generate
        task = {
            "name": "Test API",
            "domain": "api_service",
            "real_need": "Need an API",
            "goal": "Build a REST API",
            "acceptance_criteria": ["API responds correctly", "Validation works"],
        }
        generate(task, "api-service", temp_output)

        assert (temp_output / "AGENTS.md").exists()
        assert (temp_output / "CLAUDE.md").exists()

        agents_md = (temp_output / "AGENTS.md").read_text(encoding="utf-8")
        assert "Test API" in agents_md
        assert "api-service" in agents_md

    def test_generate_web_app(self, temp_output):
        from generate import generate
        task = {
            "name": "Test Web App",
            "domain": "web_app",
            "real_need": "Need a web app",
            "goal": "Build a web application",
            "acceptance_criteria": ["Users can sign up"],
        }
        generate(task, "web-app", temp_output)

        agents_md = (temp_output / "AGENTS.md").read_text(encoding="utf-8")
        assert "web-app" in agents_md

    def test_different_templates_produce_different_output(self, temp_output):
        from generate import generate
        task_api = {
            "name": "API Project",
            "domain": "api_service",
            "goal": "Build API",
            "acceptance_criteria": ["test"],
        }
        task_web = {
            "name": "Web Project",
            "domain": "web_app",
            "goal": "Build web app",
            "acceptance_criteria": ["test"],
        }

        api_dir = temp_output / "api"
        web_dir = temp_output / "web"
        generate(task_api, "api-service", api_dir)
        generate(task_web, "web-app", web_dir)

        api_ki = yaml.safe_load((api_dir / "context" / "knowledge-index.yaml").read_text())
        web_ki = yaml.safe_load((web_dir / "context" / "knowledge-index.yaml").read_text())
        assert api_ki.get("mappings") != web_ki.get("mappings")

        api_rules = yaml.safe_load((api_dir / "constraints" / "architecture-rules.yaml").read_text(encoding="utf-8"))
        web_rules = yaml.safe_load((web_dir / "constraints" / "architecture-rules.yaml").read_text(encoding="utf-8"))
        assert api_rules.get("dependency_direction") != web_rules.get("dependency_direction")

    def test_all_layers_present(self, temp_output):
        from generate import generate, LAYER_ARTIFACTS
        task = {
            "name": "Layer Test",
            "domain": "api_service",
            "goal": "Test layers",
            "acceptance_criteria": ["test"],
            # ARTIFACT_GATE (v2.5+) gates human-interface (C>=4), audit-log
            # (C>=4), session-replay (tier==full): use a full-profile task so
            # every declared artifact is copied.
            "complexity": {"scope": 3, "criticality": 4, "novelty": 4,
                           "coupling": 4, "tier": "full"},
        }
        generate(task, "api-service", temp_output)

        for layer, artifacts in LAYER_ARTIFACTS.items():
            for artifact in artifacts:
                assert (temp_output / layer / artifact).exists(), f"Missing: {layer}/{artifact}"


class TestInterpreter:
    def test_api_intent(self):
        sys.path.insert(0, str(HARNESS_ROOT / "scripts"))
        from interpret import interpret_intent
        result = interpret_intent("I need a REST API for managing tasks")
        assert result["domain"] == "api_service"
        assert len(result["acceptance_criteria"]) > 0

    def test_web_app_intent(self):
        from interpret import interpret_intent
        result = interpret_intent("Build a web dashboard for analytics")
        assert result["domain"] == "web_app"

    def test_automation_intent(self):
        from interpret import interpret_intent
        result = interpret_intent("Automate the weekly report generation")
        assert result["domain"] == "automation"

    def test_goal_extraction(self):
        from interpret import interpret_intent
        result = interpret_intent("I need a customer onboarding system")
        assert "customer onboarding" in result["goal"].lower()


class TestEvolution:
    def test_evolve_dry_run(self):
        from evolve import load_genome, measure_fitness, collect_evidence
        generated_dir = HARNESS_ROOT / "generated"
        if not generated_dir.exists():
            pytest.skip("No generated projects to test evolution")
        projects = [d for d in generated_dir.iterdir() if d.is_dir()]
        if not projects:
            pytest.skip("No generated projects")
        project = projects[0]
        genome = load_genome(project)
        evidence = collect_evidence(project)
        fitness = measure_fitness(genome, evidence)
        assert 0 <= fitness <= 1
