"""P0-3b R-03: the worker runs in the user's interpreter (GRAPHLOUPE_WORKER_PYTHON),
with the app dir injected on PYTHONPATH so the foreign interpreter can import the
sidecar modules. Falls back to sys.executable (3a single-environment) when unset."""
import os
import sys

from graphloupe_sidecar import server


def test_worker_python_falls_back_to_sys_executable(monkeypatch):
    monkeypatch.delenv("GRAPHLOUPE_WORKER_PYTHON", raising=False)
    assert server._worker_python() == sys.executable


def test_worker_python_uses_env_when_set(monkeypatch):
    monkeypatch.setenv("GRAPHLOUPE_WORKER_PYTHON", "/opt/proj/.venv/bin/python")
    assert server._worker_python() == "/opt/proj/.venv/bin/python"


def test_worker_env_prepends_app_dir_when_pythonpath_empty(monkeypatch):
    monkeypatch.delenv("PYTHONPATH", raising=False)
    env = server._worker_env()
    assert env["PYTHONPATH"].split(os.pathsep)[0] == server._APP_DIR


def test_worker_env_prepends_app_dir_keeping_existing(monkeypatch):
    monkeypatch.setenv("PYTHONPATH", "/existing/path")
    parts = server._worker_env()["PYTHONPATH"].split(os.pathsep)
    assert parts[0] == server._APP_DIR
    assert "/existing/path" in parts
