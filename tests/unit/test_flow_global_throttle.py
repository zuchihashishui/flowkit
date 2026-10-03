import asyncio

import pytest

from agent.services import flow_batch as fb
from agent.services import flow_client as fc


@pytest.mark.asyncio
async def test_generation_rpc_is_globally_serialized(monkeypatch):
    monkeypatch.setattr(fc, "FLOW_GENERATION_MAX_CONCURRENT", 1)
    monkeypatch.setattr(fc, "FLOW_GENERATION_MIN_INTERVAL_S", 0.0)
    client = fc.FlowClient()
    active = 0
    max_active = 0

    async def fake_send(method, params, timeout=300):
        nonlocal active, max_active
        assert method == "batch_rpc"
        active += 1
        max_active = max(max_active, active)
        await asyncio.sleep(0.01)
        active -= 1
        return {"status": 200, "data": "ok"}

    monkeypatch.setattr(client, "_send", fake_send)
    await asyncio.gather(
        client.batch_rpc("a", "x", captcha_action=fb.CAPTCHA_VIDEO),
        client.batch_rpc("b", "y", captcha_action=fb.CAPTCHA_IMAGE),
    )
    assert max_active == 1


@pytest.mark.asyncio
async def test_unusual_activity_opens_local_circuit_breaker(monkeypatch):
    monkeypatch.setattr(fc, "FLOW_GENERATION_MAX_CONCURRENT", 1)
    monkeypatch.setattr(fc, "FLOW_GENERATION_MIN_INTERVAL_S", 0.0)
    monkeypatch.setattr(fc, "FLOW_UNUSUAL_ACTIVITY_COOLDOWN_S", 120.0)
    client = fc.FlowClient()
    calls = 0

    async def fake_send(method, params, timeout=300):
        nonlocal calls
        calls += 1
        return {
            "status": 200,
            "data": "PUBLIC_ERROR_UNUSUAL_ACTIVITY reCAPTCHA evaluation failed",
        }

    monkeypatch.setattr(client, "_send", fake_send)
    first = await client.batch_rpc("a", "x", captcha_action=fb.CAPTCHA_VIDEO)
    second = await client.batch_rpc("b", "y", captcha_action=fb.CAPTCHA_VIDEO)

    assert first["status"] == 200
    assert second["status"] == 429
    assert "local cooldown active" in second["error"]
    assert calls == 1
    assert client.generation_guard_status["cooldown_active"] is True
    assert client.generation_guard_status["last_unusual_activity_rpc"] == "a"


@pytest.mark.asyncio
async def test_non_generation_rpc_bypasses_generation_guard(monkeypatch):
    client = fc.FlowClient()
    client._generation_unusual_until = asyncio.get_running_loop().time() + 60
    calls = 0

    async def fake_send(method, params, timeout=300):
        nonlocal calls
        calls += 1
        return {"status": 200, "data": "metadata"}

    monkeypatch.setattr(client, "_send", fake_send)
    result = await client.batch_rpc("meta", "x")
    assert result["status"] == 200
    assert calls == 1


@pytest.mark.asyncio
async def test_three_generation_requests_overlap_with_spacing_and_waiters(monkeypatch):
    monkeypatch.setattr(fc, "FLOW_GENERATION_MAX_CONCURRENT", 3)
    monkeypatch.setattr(fc, "FLOW_GENERATION_MIN_INTERVAL_S", 0.015)
    client = fc.FlowClient()
    release = asyncio.Event()
    three = asyncio.Event()
    timestamps = []
    async def send(method, params, timeout=300):
        timestamps.append(asyncio.get_running_loop().time())
        if len(timestamps) == 3:
            three.set()
        await release.wait()
        return {"status": 200, "data": "ok"}
    monkeypatch.setattr(client, "_send", send)
    tasks = [asyncio.create_task(client.batch_rpc(str(i), "x", captcha_action=fb.CAPTCHA_IMAGE)) for i in range(4)]
    try:
        await asyncio.wait_for(three.wait(), 2)
        assert client.generation_guard_status["active_submissions"] == 3
        assert client.generation_guard_status["waiting_submissions"] == 1
        assert all(b-a >= 0.014 for a, b in zip(timestamps, timestamps[1:]))
        tasks[3].cancel()
        await asyncio.gather(tasks[3], return_exceptions=True)
        assert client.generation_guard_status["waiting_submissions"] == 0
        release.set()
        await asyncio.gather(*tasks[:3])
        assert client.generation_guard_status["active_submissions"] == 0
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


@pytest.mark.asyncio
async def test_cooldown_started_during_spacing_prevents_waiting_submit(monkeypatch):
    monkeypatch.setattr(fc, "FLOW_GENERATION_MAX_CONCURRENT", 3)
    monkeypatch.setattr(fc, "FLOW_GENERATION_MIN_INTERVAL_S", 0.04)
    client = fc.FlowClient()
    calls = 0
    async def send(method, params, timeout=300):
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.01)
        return {"status": 200, "data": "PUBLIC_ERROR_UNUSUAL_ACTIVITY"}
    monkeypatch.setattr(client, "_send", send)
    results = await asyncio.gather(*(client.batch_rpc(str(i), "x", captcha_action=fb.CAPTCHA_IMAGE) for i in range(3)))
    assert calls == 1
    assert sum(result["status"] == 429 for result in results) == 2
    assert client.generation_guard_status["active_submissions"] == 0
