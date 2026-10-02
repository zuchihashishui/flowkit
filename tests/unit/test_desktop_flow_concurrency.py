"""Concurrent durable Desktop media queue; no real Flow generation calls."""
import asyncio
import json
import sqlite3
import uuid
from types import SimpleNamespace

import pytest

from agent.api import desktop as d


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(d, "STORE", tmp_path / "jobs.db")
    monkeypatch.setattr(d, "ROOT", tmp_path / "output")
    monkeypatch.setattr(d, "paused", False)
    monkeypatch.setattr(d, "get_flow_client", lambda: SimpleNamespace(connected=True, generation_guard_status={}))


def fast_scheduler(monkeypatch):
    original = asyncio.sleep
    async def sleep(_):
        await original(0)
    monkeypatch.setattr(d.asyncio, "sleep", sleep)
    return original


@pytest.mark.asyncio
async def test_three_media_overlap_and_saved_jobs_release_slots(monkeypatch):
    job = d.Job(kind="image", prompt="A boat", project_id=str(uuid.uuid4()))
    await d.enqueue(d.Batch(jobs=[job] * 7))
    release = asyncio.Event()
    three = asyncio.Event()
    active = peak = calls = 0
    async def generate(_):
        nonlocal active, peak, calls
        calls += 1
        active += 1
        peak = max(peak, active)
        if active == 3:
            three.set()
        await release.wait()
        active -= 1
        return {"media": [{"image": {"generatedImage": {"fifeUrl": "https://flow-content.google/test"}}}]}
    async def download(_, target):
        target.write_bytes(b"mock media; validation covered separately")
        return target
    monkeypatch.setattr(d.flow, "generate_image", generate)
    monkeypatch.setattr(d, "download", download)
    original_sleep = fast_scheduler(monkeypatch)
    task = asyncio.create_task(d.run())
    try:
        await asyncio.wait_for(three.wait(), 2)
        assert calls == 3
        progress = await d.flow_progress()
        assert progress["active"] == 3 and progress["queued"] == 4
        release.set()
        async def completed():
            while any(row["state"] != "COMPLETED" for row in d.rows()):
                await original_sleep(0)
        await asyncio.wait_for(completed(), 2)
        assert peak == 3 and calls == 7
        assert all(json.loads(row["files"]) for row in d.rows())
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_cooldown_holds_fresh_work_but_allows_saved_download(monkeypatch):
    job = d.Job(kind="image", prompt="A boat", project_id=str(uuid.uuid4()))
    ids = (await d.enqueue(d.Batch(jobs=[job, job])))["ids"]
    d.update(ids[1], remote=json.dumps({"urls": ["https://flow-content.google/saved"]}))
    guard = {"cooldown_active": True, "cooldown_remaining_s": 90}
    monkeypatch.setattr(d, "get_flow_client", lambda: SimpleNamespace(connected=True, generation_guard_status=guard))
    done = asyncio.Event()
    async def download(_, target):
        target.write_bytes(b"fixture")
        done.set()
        return target
    async def forbidden(_):
        pytest.fail("Fresh generation must wait for cooldown")
    monkeypatch.setattr(d.flow, "generate_image", forbidden)
    monkeypatch.setattr(d, "download", download)
    fast_scheduler(monkeypatch)
    task = asyncio.create_task(d.run())
    try:
        await asyncio.wait_for(done.wait(), 2)
        progress = await d.flow_progress()
        fresh = next(row for row in progress["jobs"] if row["id"] == ids[0])
        assert fresh["state"] == "QUEUED" and fresh["stage"] == "COOLDOWN"
        assert progress["completed"] == 1
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_pause_keeps_unclaimed_jobs_in_queue(monkeypatch):
    job = d.Job(kind="image", prompt="A boat", project_id=str(uuid.uuid4()))
    await d.enqueue(d.Batch(jobs=[job] * 4))
    release = asyncio.Event()
    three = asyncio.Event()
    calls = 0
    async def generate(_):
        nonlocal calls
        calls += 1
        if calls == 3:
            three.set()
        await release.wait()
        return {"media": [{"image": {"generatedImage": {"fifeUrl": "https://flow-content.google/test"}}}]}
    async def download(_, target):
        target.write_bytes(b"fixture")
        return target
    monkeypatch.setattr(d.flow, "generate_image", generate)
    monkeypatch.setattr(d, "download", download)
    original_sleep = fast_scheduler(monkeypatch)
    task = asyncio.create_task(d.run())
    try:
        await asyncio.wait_for(three.wait(), 2)
        await d.pause(d.Pause(paused=True))
        release.set()
        for _ in range(10):
            await original_sleep(0)
        assert calls == 3
        progress = await d.flow_progress()
        assert progress["completed"] == 3 and progress["queued"] == 1
        assert next(row for row in progress["jobs"] if row["state"] == "QUEUED")["stage"] == "PAUSED"
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_progress_migrates_old_database_and_omits_prompts_and_remote_urls():
    with sqlite3.connect(d.STORE) as db:
        db.execute("CREATE TABLE jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL, remote TEXT, files TEXT NOT NULL DEFAULT '[]', error TEXT, created REAL NOT NULL)")
        db.execute("INSERT INTO jobs VALUES(?,?,?,?,?,?,?)", ("old", json.dumps({"kind": "image", "prompt": "PRIVATE PROMPT", "label": "Scene 1"}), "RUNNING", "PRIVATE REMOTE", "[]", None, 1))
    progress = await d.flow_progress()
    assert progress["active"] == 1
    assert progress["jobs"][0]["stage"] == "RUNNING"
    assert "PRIVATE" not in json.dumps(progress)
    assert "remote" not in progress["jobs"][0] and "payload" not in progress["jobs"][0]


@pytest.mark.asyncio
async def test_voice_lane_is_single_while_media_uses_three_slots(monkeypatch):
    async def voice_template(_):
        return SimpleNamespace()
    monkeypatch.setattr(d.tts, "get_voice_template", voice_template)
    image = d.Job(kind="image", prompt="Boat", project_id=str(uuid.uuid4()))
    voice = d.Job(kind="voice", prompt="Hello", template="sample")
    await d.enqueue(d.Batch(jobs=[voice, voice, image, image, image, image]))
    started = []
    full = asyncio.Event()
    release = asyncio.Event()
    async def process(row):
        kind = json.loads(row["payload"])["kind"]
        started.append(kind)
        if len(started) == 4:
            full.set()
        await release.wait()
    monkeypatch.setattr(d, "process", process)
    fast_scheduler(monkeypatch)
    task = asyncio.create_task(d.run())
    try:
        await asyncio.wait_for(full.wait(), 2)
        assert started.count("voice") == 1
        assert started.count("image") == 3
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
