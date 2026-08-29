#!/usr/bin/env python3
"""
Test suite for the Meta-Harness generation pipeline.

v1 (generate.py + templates/) was removed in favor of the v2 flow
(scaffold.py script -> LLM slot authoring -> validate-harness.py gate), so the
template-bucket tests were replaced by scaffold-equivalent coverage here and in
tests/test_research.py (domain-brief slot + research grounding).

Run: python -m pytest tests/ -v
"""

import shutil
import subprocess
import sys
from pathlib import Path

import yaml
import pytest

HARNESS_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = HARNESS_ROOT / "scripts"

if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))


def _run(cwd, *args):
    proc = subprocess.run([sys.executable, *args], cwd=str(cwd),
                          capture_output=True, text=True, encoding="utf-8",
                          errors="replace")
    return proc.returncode, proc.stdout + proc.stderr


def _write_task(path: Path, **extra) -> Path:
    task = {
        "name": "Test API",
        "domain": "api_service",
        "goal": "Build a REST API",
        "acceptance_criteria": ["API responds correctly", "Validation works"],
        "complexity": {"scope": 3, "criticality": 3, "novelty": 3,
                       "coupling": 3, "tier": "standard"},
    }
    task.update(extra)
    path.write_text(yaml.dump(task), encoding="utf-8")
    return path


def _scaffold(tmp_path, task=None) -> tuple:
    task = task or _write_task(tmp_path / "task.yaml")
    out = tmp_path / "gen"
    code, out_text = _run(tmp_path, str(SCRIPTS / "scaffold.py"),
                          "--task", str(task), "--output", str(out))
    return code, out_text, out


# ---------------------------------------------------------------- v2 scaffold

class TestScaffold:
    def test_scaffold_creates_all_layer_dirs(self, tmp_path):
        code, out, gen = _scaffold(tmp_path)
        assert code == 0, out
        for layer in ("context", "tools", "memory", "planning", "verification",
                      "feedback", "constraints", "security", "observability",
                      "evolution", "runtime", "docs", "seams"):
            assert (gen / layer).is_dir(), f"missing layer dir: {layer}"

    def test_scaffold_emits_root_and_manifest(self, tmp_path):
        code, out, gen = _scaffold(tmp_path)
        assert code == 0, out
        for f in ("AGENTS.md", "CLAUDE.md", ".cursorrules", "task.yaml",
                  "harness-scaffold.yaml", "harness-profile.yaml",
                  "harness-composition.yaml", "orchestrator.py", "guard.py"):
            assert (gen / f).exists(), f"missing root artifact: {f}"
        manifest = yaml.safe_load((gen / "harness-scaffold.yaml").read_text(encoding="utf-8"))
        assert len(manifest["llm_slots"]) > 0
        # C: the dynamic domain template is always an LLM slot
        assert any(s["file"] == "context/domain-brief.yaml" for s in manifest["llm_slots"])
        profile = yaml.safe_load((gen / "harness-profile.yaml").read_text(encoding="utf-8"))
        assert profile["factors"]["scope"] == 3

    def test_scaffold_rejects_invalid_task(self, tmp_path):
        task = tmp_path / "task.yaml"
        task.write_text("name: X\ndomain: api_service\n", encoding="utf-8")  # goal missing
        code, out = _run(tmp_path, str(SCRIPTS / "scaffold.py"),
                         "--task", str(task), "--output", str(tmp_path / "gen"))
        assert code != 0 and "Missing required field" in out

    def test_scaffold_refuses_overwrite_non_harness_dir(self, tmp_path):
        _write_task(tmp_path / "task.yaml")
        (tmp_path / "gen").mkdir()
        (tmp_path / "gen" / "precious.txt").write_text("keep", encoding="utf-8")
        code, out = _run(tmp_path, str(SCRIPTS / "scaffold.py"),
                         "--task", str(tmp_path / "task.yaml"),
                         "--output", str(tmp_path / "gen"))
        assert code != 0 and "Refusing to overwrite" in out
        assert (tmp_path / "gen" / "precious.txt").exists()


# ---------------------------------------------------------------- interpreter

class TestInterpreter:
    def test_api_intent(self):
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


# ---------------------------------------------------------------- evolution

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
