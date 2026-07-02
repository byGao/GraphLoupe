"""Discover graph entry points under a project root WITHOUT executing user code.

AST-parses *.py for a top-level `build_graph` function and prints JSON entries
[{entry, file, line}] for the Select-Graph picker. No imports = safe to scan an
untrusted repo (a module that raises on import won't crash discovery).

Usage: python -m graphloupe_sidecar.discover --project-root <dir>
"""
from __future__ import annotations

import argparse
import ast
import json
import os
from pathlib import Path

SKIP_DIRS = {".git", "__pycache__", ".venv", "venv", "node_modules", ".mypy_cache", ".pytest_cache"}
# Common graph-factory names; also detected: any fn that calls .compile() in a file
# that imports langgraph (catches build_app, make_graph, etc. — not just build_graph).
KNOWN_FACTORY_NAMES = {"build_graph", "build_app", "make_graph", "create_graph"}


def _module_path(file: Path, root: Path) -> str:
    rel = file.relative_to(root)
    parts = list(rel.parts)
    if parts[-1] == "__init__.py":
        parts = parts[:-1]
    else:
        parts[-1] = parts[-1][:-3]  # strip ".py"
    return ".".join(parts)


def _imports_langgraph(tree: ast.Module) -> bool:
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            if any(a.name.split(".")[0] == "langgraph" for a in node.names):
                return True
        elif isinstance(node, ast.ImportFrom):
            if (node.module or "").split(".")[0] == "langgraph":
                return True
    return False


def _calls_compile(func: ast.AST) -> bool:
    for node in ast.walk(func):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            if node.func.attr == "compile":  # g.compile() -> a compiled graph factory
                return True
    return False


def list_symbols(file: str) -> list[dict[str, object]]:
    """Top-level symbols a user could point a graph entry at (P0-4 manual wizard):
    function defs and module-level assignments. AST only — never executes the file."""
    try:
        tree = ast.parse(Path(file).read_text(encoding="utf-8"), filename=str(file))
    except (SyntaxError, UnicodeDecodeError, OSError):
        return []
    out: list[dict[str, object]] = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            out.append({"name": node.name, "kind": "function", "line": node.lineno})
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    out.append({"name": target.id, "kind": "variable", "line": node.lineno})
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            out.append({"name": node.target.id, "kind": "variable", "line": node.lineno})
    return out


def _module_of(file: str, root: str) -> str:
    """Module path for a picked file; falls back to the file stem if it's outside root."""
    try:
        return _module_path(Path(file), Path(root))
    except ValueError:
        return Path(file).stem


def discover(root: str) -> list[dict[str, object]]:
    root_path = Path(root)
    found: list[dict[str, object]] = []
    for dirpath, dirnames, filenames in os.walk(root_path):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for name in filenames:
            if not name.endswith(".py"):
                continue
            file = Path(dirpath) / name
            try:
                tree = ast.parse(file.read_text(encoding="utf-8"), filename=str(file))
            except (SyntaxError, UnicodeDecodeError, OSError):
                continue  # unparseable file -> skip, never raise
            has_langgraph = _imports_langgraph(tree)
            for node in tree.body:  # top-level defs only
                if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                if node.name in KNOWN_FACTORY_NAMES or (has_langgraph and _calls_compile(node)):
                    found.append({
                        "entry": f"{_module_path(file, root_path)}:{node.name}",
                        "file": str(file),
                        "line": node.lineno,
                    })
    found.sort(key=lambda e: str(e["entry"]))
    return found


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", required=True)
    parser.add_argument("--symbols", help="a .py file: emit {module, symbols} for the entry wizard")
    args = parser.parse_args()
    if args.symbols:
        print(json.dumps({
            "module": _module_of(args.symbols, args.project_root),
            "symbols": list_symbols(args.symbols),
        }))
    else:
        print(json.dumps(discover(args.project_root)))


if __name__ == "__main__":
    main()
