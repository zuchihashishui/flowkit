"""Desktop persistence and recovery tests; no calls to Google or voice models."""
import json
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from agent.api import desktop as d


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(d, "STORE", tmp_path / "jobs.db")
    monkeypatch.setattr(d, "ROOT", tmp_path / "output")
    monkeypatch.setattr(d, "get_flow_client", lambda: SimpleNamespace(connected=True))
    monkeypatch.setattr(d, "paused", False)


@pytest.mark.asyncio
async def test_cancel_only_queued_and_stale_worker_cannot_submit(monkeypatch):
    body = d.Job(kind="image", prompt="boat", project_id=str(uuid.uuid4()))
    ids = (await d.enqueue(d.Batch(jobs=[body, body])))["ids"]
    stale = next(r for r in d.rows() if r["id"] == ids[0])
    d.update(ids[1], state="SUBMITTING")
    result = await d.cancel_jobs(d.CancelBatch(ids=[*ids, ids[0], "missing"]))
    assert result["cancelled"] == [ids[0]]
    assert result["skipped"] == [ids[1], "missing"]
    submit = AsyncMock(side_effect=AssertionError("Cancelled work must not submit"))
    monkeypatch.setattr(d.flow, "generate_image", submit)
    await d.process(stale)
    submit.assert_not_called()
    assert next(r for r in d.rows() if r["id"] == ids[0])["state"] == "CANCELLED"
    assert next(r for r in d.rows() if r["id"] == ids[1])["state"] == "SUBMITTING"


@pytest.mark.asyncio
async def test_pause_survives_worker_restart(monkeypatch):
    import asyncio
    await d.pause(d.Pause(paused=True))
    d.paused = False
    monkeypatch.setattr(d.asyncio, "sleep", AsyncMock(side_effect=asyncio.CancelledError))
    with pytest.raises(asyncio.CancelledError):
        await d.run()
    assert d.paused is True
    await d.pause(d.Pause(paused=False))
    with d.connection() as db:
        assert db.execute("SELECT value FROM preferences WHERE key='paused'").fetchone()["value"] == "false"


@pytest.mark.asyncio
async def test_only_saved_failed_results_are_resumable():
    body = d.Job(kind="image", prompt="boat", project_id=str(uuid.uuid4()))
    ids = (await d.enqueue(d.Batch(jobs=[body, body])))["ids"]
    d.update(ids[0], state="FAILED", remote=json.dumps({"urls": ["https://flow-content.google/image/test"]}))
    d.update(ids[1], state="FAILED")
    jobs = {j["id"]: j for j in (await d.list_jobs())["jobs"]}
    assert jobs[ids[0]]["can_resume"] is True
    assert jobs[ids[1]]["can_resume"] is False
    assert jobs[ids[0]]["remote"] is None


@pytest.mark.asyncio
async def test_batch_is_atomic():
    batch = d.Batch(jobs=[d.Job(kind="image", prompt="boat", project_id=str(uuid.uuid4())),
                         d.Job(kind="image", prompt="boat", project_id="bad")])
    with pytest.raises(HTTPException) as exc:
        await d.enqueue(batch)
    assert exc.value.status_code == 400
    assert d.rows() == []


@pytest.mark.asyncio
async def test_disconnected_does_not_queue(monkeypatch):
    monkeypatch.setattr(d, "get_flow_client", lambda: SimpleNamespace(connected=False))
    with pytest.raises(HTTPException) as exc:
        await d.enqueue(d.Batch(jobs=[d.Job(kind="image", prompt="boat", project_id=str(uuid.uuid4()))]))
    assert exc.value.status_code == 503
    assert d.rows() == []


@pytest.mark.asyncio
async def test_resume_reuses_saved_workflow(monkeypatch):
    batch = d.Batch(jobs=[d.Job(kind="video", prompt="boat", project_id=str(uuid.uuid4()))])
    jid = (await d.enqueue(batch))["ids"][0]
    remote = {"workflows": [{"name": "workflow", "primary_media_id": str(uuid.uuid4())}]}
    d.update(jid, state="FAILED", remote=json.dumps(remote))
    submit = AsyncMock(side_effect=AssertionError("Must not generate twice"))
    monkeypatch.setattr(d.flow, "generate_video_omni_text", submit)
    monkeypatch.setattr(d.flow, "check_omni_status", AsyncMock(return_value={"done": True, "workflows": [{"media": {"url": "https://flow-content.google/video/test"}}]}))
    async def download(url, target):
        target.write_bytes(b"test fixture, validated separately")
        return target
    monkeypatch.setattr(d, "download", download)
    await d.resume(jid)
    await d.process(d.rows()[0])
    result = d.rows()[0]
    assert result["state"] == "COMPLETED"
    assert len(json.loads(result["files"])) == 1
    submit.assert_not_called()


@pytest.mark.asyncio
async def test_download_failure_preserves_result(monkeypatch):
    jid = (await d.enqueue(d.Batch(jobs=[d.Job(kind="image", prompt="boat", project_id=str(uuid.uuid4()))])))["ids"][0]
    remote = {"urls": ["https://flow-content.google/image/test"]}
    d.update(jid, remote=json.dumps(remote))
    monkeypatch.setattr(d, "download", AsyncMock(side_effect=ValueError("Invalid media")))
    await d.process(d.rows()[0])
    result = d.rows()[0]
    assert result["state"] == "FAILED"
    assert json.loads(result["remote"]) == remote
    assert json.loads(result["files"]) == []
    await d.resume(jid)
    assert d.rows()[0]["state"] == "QUEUED"


@pytest.mark.asyncio
async def test_uncertain_submission_cannot_resume():
    jid = (await d.enqueue(d.Batch(jobs=[d.Job(kind="image", prompt="boat", project_id=str(uuid.uuid4()))])))["ids"][0]
    d.update(jid, state="FAILED")
    with pytest.raises(HTTPException) as exc:
        await d.resume(jid)
    assert exc.value.status_code == 409


@pytest.mark.parametrize("url", ["http://flow-content.google/a", "https://flow-content.google.evil.com/a", "https://localhost/a", "https://flow-content.google:444/a", "https://user@flow-content.google/a"])
def test_download_host_boundary(url):
    with pytest.raises(ValueError):
        d.safe_media_url(url)


@pytest.mark.asyncio
async def test_file_cannot_escape_output(tmp_path):
    jid = (await d.enqueue(d.Batch(jobs=[d.Job(kind="image", prompt="boat", project_id=str(uuid.uuid4()))])))["ids"][0]
    outside = tmp_path / "private.txt"
    outside.write_text("private")
    d.update(jid, state="COMPLETED", files=json.dumps([str(outside)]))
    with pytest.raises(HTTPException) as exc:
        await d.file(jid, 0)
    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_real_media_validation(tmp_path):
    import shutil
    import wave
    if not shutil.which("ffprobe"):
        pytest.skip("ffprobe is not installed")
    audio = tmp_path / "test.wav"
    with wave.open(str(audio), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24000)
        wav.writeframes(b"\0\0" * 2400)
    assert await d.validate_media(audio, "voice")
    with pytest.raises(ValueError):
        await d.validate_media(audio, "video")
    invalid = tmp_path / "error.mp4"
    invalid.write_text("<html>Service error</html>")
    with pytest.raises(ValueError):
        await d.validate_media(invalid, "video")


def test_voice_import_http(tmp_path, monkeypatch):
    import io
    import shutil
    import wave
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        pytest.skip("FFmpeg required")
    monkeypatch.setattr(d.tts, "TEMPLATES_DIR", tmp_path / "templates")
    monkeypatch.setattr(d.tts, "TEMPLATES_META", tmp_path / "templates" / "templates.json")
    app = FastAPI()
    app.include_router(d.router, prefix="/api")
    app.include_router(d.tts.router, prefix="/api")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(b"\0\0" * 1600)
    with TestClient(app) as client:
        data = {"name": "test_voice", "text": "Xin chào, こんにちは", "consent": "true"}
        response = client.post("/api/desktop/voices/import", data=data, files={"audio": ("sample.wav", buf.getvalue(), "audio/wav")})
        assert response.status_code == 200, response.text
        assert response.json()["name"] == "test_voice"
        assert client.get("/api/tts/templates").json()[0]["name"] == "test_voice"
        again = client.post("/api/desktop/voices/import", data=data, files={"audio": ("sample.wav", buf.getvalue(), "audio/wav")})
        assert again.status_code == 409
        queued = client.post("/api/desktop/jobs", json={"jobs": [{"kind": "voice", "prompt": "Hello", "template": "test_voice"}]})
        assert queued.status_code == 200
        assert client.get("/api/desktop/jobs").json()["jobs"][0]["state"] == "QUEUED"


def test_scene_creation_preserves_narration():
    from agent.models.scene import SceneCreate
    scene = SceneCreate(video_id="test", prompt="boat", narrator_text="A journey begins.")
    assert scene.model_dump()["narrator_text"] == "A journey begins."


@pytest.mark.asyncio
async def test_scene_database_narration(tmp_path, monkeypatch):
    from agent.db import schema, crud
    from agent.api.scenes import create, update as update_scene
    from agent.models.scene import SceneCreate, SceneUpdate
    monkeypatch.setattr(schema, "DB_PATH", tmp_path / "scenes.db")
    await schema.init_db()
    try:
        project = await crud.create_project(name="Desktop test", material="realistic")
        video = await crud.create_video(project_id=project["id"], title="Collection")
        result = await create(SceneCreate(video_id=video["id"], prompt="Boat", narrator_text="A journey begins."))
        assert result["narrator_text"] == "A journey begins."
        saved = await crud.get_scene(result["id"])
        assert saved["narrator_text"] == "A journey begins."
        await update_scene(result["id"], SceneUpdate(prompt="Updated boat", narrator_text="Updated narration", video_prompt=None))
        saved = await crud.get_scene(result["id"])
        assert saved["prompt"] == "Updated boat"
        assert saved["narrator_text"] == "Updated narration"
        assert saved["video_prompt"] is None
    finally:
        await schema.close_db()


def test_template_metadata_unicode_bom_and_atomic_failure(tmp_path, monkeypatch):
    from agent.api import tts
    path = tmp_path / "templates.json"
    monkeypatch.setattr(tts, "TEMPLATES_META", path)
    meta = {"narrator": {"name": "narrator", "text": "Xin chào, こんにちは"}}
    tts._save_templates_meta(meta)
    assert json.loads(path.read_text(encoding="utf-8")) == meta
    path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8-sig")
    assert tts._load_templates_meta() == meta
    original = path.read_bytes()
    def denied(*args):
        raise PermissionError("File is locked")
    monkeypatch.setattr(tts.os, "replace", denied)
    with pytest.raises(HTTPException, match="Cannot save voice templates"):
        tts._save_templates_meta({})
    assert path.read_bytes() == original
    assert not list(tmp_path.glob("*.tmp"))


@pytest.mark.parametrize("content", ['{broken', '[]'])
def test_voice_import_bad_metadata_returns_actionable_json(tmp_path, monkeypatch, content):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    path = tmp_path / "templates.json"
    path.write_text(content, encoding="utf-8")
    monkeypatch.setattr(d.tts, "TEMPLATES_META", path)
    monkeypatch.setattr(d.tts, "TEMPLATES_DIR", tmp_path)
    app = FastAPI()
    app.include_router(d.router, prefix="/api")
    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.post("/api/desktop/voices/import",
            data={"name": "narrator", "text": "Hello", "consent": "true"},
            files={"audio": ("sample.mp3", b"unused", "audio/mpeg")})
    assert response.status_code == 500
    assert "Cannot read voice templates" in response.json()["detail"]
    assert path.read_text(encoding="utf-8") == content


def test_voice_import_unwritable_directory_returns_json(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    folder = tmp_path / "not_a_directory"
    folder.write_text("keep")
    monkeypatch.setattr(d.tts, "TEMPLATES_DIR", folder)
    monkeypatch.setattr(d.tts, "TEMPLATES_META", tmp_path / "missing.json")
    app = FastAPI()
    app.include_router(d.router, prefix="/api")
    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.post("/api/desktop/voices/import",
            data={"name": "narrator", "text": "Hello", "consent": "true"},
            files={"audio": ("sample.mp3", b"unused", "audio/mpeg")})
    assert response.status_code == 500
    assert "Cannot write voice files" in response.json()["detail"]
    assert folder.read_text() == "keep"
