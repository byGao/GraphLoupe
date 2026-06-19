"""graph-picker AC-01/02 (headless): discover build_graph entries via AST, no execution."""
from __future__ import annotations

from pathlib import Path

from graphloupe_sidecar.discover import discover


def _write(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")


def test_ac01_finds_build_graph_entries_with_module_paths(tmp_path: Path) -> None:
    _write(tmp_path / "flow.py", "def build_graph():\n    pass\n")
    _write(tmp_path / "pkg" / "graph.py", "def build_graph():\n    pass\n")
    _write(tmp_path / "pkg" / "other.py", "def helper():\n    pass\n")  # no build_graph

    entries = {e["entry"] for e in discover(str(tmp_path))}
    assert entries == {"flow:build_graph", "pkg.graph:build_graph"}


def test_ac02_ast_does_not_execute_and_skips_envs(tmp_path: Path) -> None:
    # A module that would crash on import must NOT crash discovery (AST, not import).
    _write(tmp_path / "boom.py", "raise RuntimeError('import side effect')\ndef build_graph():\n    pass\n")
    # Files under skipped dirs must be ignored.
    _write(tmp_path / ".venv" / "lib" / "vendor.py", "def build_graph():\n    pass\n")
    _write(tmp_path / "__pycache__" / "cached.py", "def build_graph():\n    pass\n")
    _write(tmp_path / "real.py", "def build_graph():\n    pass\n")

    entries = {e["entry"] for e in discover(str(tmp_path))}
    assert "real:build_graph" in entries
    assert "boom:build_graph" in entries          # listed via AST despite the raise
    assert not any("vendor" in e or "cached" in e for e in entries)  # skipped dirs
