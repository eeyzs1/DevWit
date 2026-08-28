"""Unit tests for composition manifest + patch merging (WP4)."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import compose  # noqa: E402


@pytest.fixture
def composition(tmp_path):
    p = tmp_path / "harness-composition.yaml"
    p.write_text(
        "version: 1\nrows:\n"
        "  - {id: guard.py, layer: root, kind: universal, source: seeds/guard.py, enabled: true, config: {}}\n"
        "  - {id: verification/self-check.py, layer: verification, kind: check, "
        "     runner: orchestrator, enabled: true, config: {}}\n"
        "  - {id: context/knowledge-index.yaml, layer: context, kind: slot, "
        "     source: seeds/context/knowledge-index.yaml, enabled: true, config: {}}\n",
        encoding="utf-8")
    return p


def test_compose_no_patch(composition):
    rows = compose.compose(composition)
    assert len(rows) == 3


def test_compose_patch_disables_and_configures(composition, tmp_path):
    patch = tmp_path / "harness-patch.yaml"
    patch.write_text(
        "version: 1\nrows:\n"
        "  - {id: verification/self-check.py, enabled: false, config: {threshold: 5}}\n",
        encoding="utf-8")
    rows = compose.compose(composition, patch)
    by_id = {r["id"]: r for r in rows}
    assert by_id["verification/self-check.py"]["enabled"] is False
    assert by_id["verification/self-check.py"]["config"]["threshold"] == 5
    assert by_id["guard.py"]["enabled"] is True


def test_compose_unknown_patch_id_fails_closed(composition, tmp_path):
    patch = tmp_path / "harness-patch.yaml"
    patch.write_text(
        "version: 1\nrows:\n  - {id: nonexistent/thing.py, enabled: false}\n",
        encoding="utf-8")
    with pytest.raises(ValueError, match="unknown row id"):
        compose.compose(composition, patch)


def test_compose_duplicate_row_id_fails(composition, tmp_path):
    bad = tmp_path / "bad.yaml"
    bad.write_text(
        "version: 1\nrows:\n  - {id: a, kind: universal, enabled: true}\n"
        "  - {id: a, kind: universal, enabled: true}\n",
        encoding="utf-8")
    with pytest.raises(ValueError, match="duplicate row id"):
        compose.load_composition(bad)


def test_compose_unknown_kind_fails(composition, tmp_path):
    bad = tmp_path / "bad.yaml"
    bad.write_text("version: 1\nrows:\n  - {id: a, kind: mystery, enabled: true}\n",
                   encoding="utf-8")
    with pytest.raises(ValueError, match="unknown kind"):
        compose.load_composition(bad)
