"""Read-only backend identity lets Studio diagnose multiple source copies."""
from datetime import datetime
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace

from fastapi.testclient import TestClient

from agent import main


def test_health_identifies_running_backend_without_starting_workers(monkeypatch):
    monkeypatch.setattr(main, "get_flow_client", lambda: SimpleNamespace(connected=False, ws_stats={"pending": 0}))
    # No lifespan: this route must not start sockets, workers, or provider jobs.
    client = TestClient(main.app)
    response = client.get("/health")
    assert response.status_code == 200
    health = response.json()
    assert health["service"] == "flowkit-backend"
    source_root = Path(main.__file__).resolve().parent.parent
    assert health["studio_version"] == json.loads((source_root / "desktop" / "package.json").read_text())["version"]
    assert health["runtime"]["pid"] == os.getpid()
    assert health["runtime"]["root"] == str(source_root)
    assert health["runtime"]["python"] == sys.executable
    assert datetime.fromisoformat(health["runtime"]["started_at"]).tzinfo is not None
    assert health["studio_api"] == 3
    assert health["studio_features"]["elevenlabs_recover_downloads"] is True
    assert health["studio_features"]["elevenlabs_auto_prepare_tab"] is True
    assert health["extension_connected"] is False
    assert health["ws"] == {"pending": 0}


def test_health_version_and_start_time_remain_snapshotted(monkeypatch):
    monkeypatch.setattr(main, "get_flow_client", lambda: SimpleNamespace(connected=False, ws_stats={}))
    client = TestClient(main.app)
    original = client.get("/health").json()

    def no_disk_read(*_args, **_kwargs):
        raise AssertionError("Health must describe the running process, not re-read updated source files")

    monkeypatch.setattr(Path, "read_text", no_disk_read)
    current = client.get("/health").json()
    assert current["studio_version"] == original["studio_version"]
    assert current["runtime"] == original["runtime"]
