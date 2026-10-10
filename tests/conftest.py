"""Isolated backend tests: no real profiles, provider calls or worker startup."""
import os
import socket
import tempfile

import pytest

# Set before application modules are imported during collection.
_runtime = tempfile.TemporaryDirectory(prefix="flowkit-tests-")
os.environ["FLOW_AGENT_DIR"] = _runtime.name


def pytest_addoption(parser):
    parser.addoption("--require-tests", action="store_true", help="Fail if no test call passes (including all-skipped suites).")


_passed = 0


def pytest_sessionstart(session):
    global _passed
    _passed = 0


def pytest_runtest_logreport(report):
    global _passed
    if report.when == "call" and report.passed:
        _passed += 1


def pytest_sessionfinish(session, exitstatus):
    if session.config.getoption("--require-tests") and exitstatus == 0 and not _passed:
        session.exitstatus = pytest.ExitCode.NO_TESTS_COLLECTED


def pytest_unconfigure(config):
    _runtime.cleanup()


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def blocked(*args, **kwargs):
        raise AssertionError("Unit tests must not open network connections")
    monkeypatch.setattr(socket.socket, "connect", blocked)
    monkeypatch.setattr(socket.socket, "connect_ex", blocked)


@pytest.fixture
async def database(tmp_path, monkeypatch):
    from agent.db import schema
    await schema.close_db()
    monkeypatch.setattr(schema, "DB_PATH", tmp_path / "flow.db")
    await schema.init_db()
    try:
        yield await schema.get_db()
    finally:
        await schema.close_db()


@pytest.fixture
def gateway(tmp_path, monkeypatch):
    from agent.services import chatgpt_gateway as g
    monkeypatch.setattr(g, "STORE", tmp_path / "chatgpt.db")
    for name in ("_inflight", "_srt_inflight", "_text_calls"):
        monkeypatch.setattr(g, name, set())
    monkeypatch.setattr(g, "_cleanup_pending", False)
    monkeypatch.setattr(g, "_restarting_text", False)
    return g


@pytest.fixture
def eleven(tmp_path):
    from agent.services.elevenlabs_bridge import ElevenLabsBridge
    return ElevenLabsBridge(tmp_path / "eleven.db", tmp_path / "audio")


@pytest.fixture
async def client(database, gateway, eleven, monkeypatch):
    import httpx
    from agent.api import elevenlabs
    from agent.main import app
    monkeypatch.setattr(elevenlabs, "bridge", eleven)
    # ASGITransport intentionally does not start lifespan/background workers.
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as value:
        yield value
