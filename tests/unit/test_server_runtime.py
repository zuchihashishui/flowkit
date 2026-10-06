"""Exercise the launcher path without loading models or binding server ports."""
import asyncio
import sys
from types import SimpleNamespace

import pytest

from agent import server_runtime as runtime


def test_windows_launcher_uses_proactor_policy_and_serves_on_that_loop(monkeypatch, caplog):
    monkeypatch.setattr(runtime, 'IS_WINDOWS', True)
    # Linux CI uses its subprocess-capable loop as the policy stand-in. Windows
    # executes this same test with the real Proactor policy.
    original = asyncio.get_event_loop_policy()
    policy = (asyncio.WindowsProactorEventLoopPolicy() if sys.platform == 'win32'
              else asyncio.DefaultEventLoopPolicy())
    monkeypatch.setattr(asyncio, 'WindowsProactorEventLoopPolicy', lambda: policy, raising=False)
    config = {}
    monkeypatch.setattr(runtime.uvicorn, 'Config', lambda app, **kwargs: config.update(app=app, **kwargs) or config)
    async def serve():
        assert asyncio.get_event_loop_policy() is policy
        if sys.platform == 'win32':
            assert isinstance(asyncio.get_running_loop(), asyncio.ProactorEventLoop)
        process = await asyncio.create_subprocess_exec(sys.executable, '-c', 'print("worker-ready")', stdout=asyncio.subprocess.PIPE)
        output, _ = await process.communicate()
        assert process.returncode == 0
        assert output.strip() == b'worker-ready'
        return 'served'
    monkeypatch.setattr(runtime.uvicorn, 'Server', lambda _: SimpleNamespace(serve=serve))
    monkeypatch.setattr(runtime.uvicorn, 'run', lambda *a, **kw: pytest.fail('Must not let uvicorn choose the Windows loop'))
    monkeypatch.setenv('WEB_CONCURRENCY', '4')
    assert runtime.run_server('agent.main:app', host='127.0.0.1', port=8100, reload=True) == 'served'
    assert config['loop'] == 'none' and config['workers'] == 1 and config['reload'] is False
    assert asyncio.get_event_loop_policy() is original
    assert 'hot reload is disabled' in caplog.text


def test_unix_launcher_keeps_existing_uvicorn_reload(monkeypatch):
    monkeypatch.setattr(runtime, 'IS_WINDOWS', False)
    calls = []
    monkeypatch.setattr(runtime.uvicorn, 'run', lambda *args, **kwargs: calls.append((args, kwargs)))
    runtime.run_server('agent.main:app', host='127.0.0.1', port=8100, reload=True)
    assert calls[0][1]['reload'] is True
    assert calls[0][1]['port'] == 8100
