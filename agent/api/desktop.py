"""Durable desktop jobs. No automatic resubmission of uncertain generations."""
import asyncio
import json
import logging
import sqlite3
import time
import uuid
import subprocess
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlparse

import aiohttp
from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from typing import Literal

from agent.config import OUTPUT_DIR, BASE_DIR
from agent.api import flow, tts
from agent.services.flow_client import get_flow_client
from agent.services.omni_flash import extract_omni_workflows

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/desktop", tags=["desktop"])
ROOT = OUTPUT_DIR / "desktop"
STORE = BASE_DIR / "desktop_jobs.db"
paused = False
MEDIA_CONCURRENCY = 3
VOICE_CONCURRENCY = 1
ACTIVE_STATES = {"RUNNING", "SUBMITTING", "DOWNLOADING"}


@contextmanager
def connection():
    STORE.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(STORE, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL, remote TEXT, files TEXT NOT NULL DEFAULT '[]', error TEXT, created REAL NOT NULL)")
    db.execute("CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    columns = {r[1] for r in db.execute("PRAGMA table_info(jobs)")}
    for name, definition in (("stage", "TEXT"), ("started", "REAL"), ("updated", "REAL")):
        if name not in columns:
            db.execute(f"ALTER TABLE jobs ADD COLUMN {name} {definition}")
    try:
        with db:
            yield db
    finally:
        db.close()


def rows():
    with connection() as db:
        return [dict(r) for r in db.execute("SELECT * FROM jobs ORDER BY created DESC")]


def update(jid, **values):
    assert set(values) <= {"state", "remote", "files", "error", "stage", "started"}
    if "state" in values and "stage" not in values:
        values["stage"] = values["state"]
    values["updated"] = time.time()
    with connection() as db:
        db.execute("UPDATE jobs SET " + ",".join(f"{k}=?" for k in values) + " WHERE id=?", [*values.values(), jid])


class Job(BaseModel):
    kind: Literal["image", "video", "voice"]
    prompt: str = Field(min_length=1, max_length=5000)
    project_id: str = ""
    scene_id: str = ""
    document_id: str = ""
    segment_id: str = ""
    concept_id: str = ""
    start_ms: int | None = None
    end_ms: int | None = None
    label: str = Field(default="Scene", max_length=100)
    orientation: Literal["HORIZONTAL", "VERTICAL"] = "HORIZONTAL"
    duration: Literal[4, 6, 8, 10] = 8
    image_model: str | None = None
    template: str | None = Field(default=None, pattern=r"^[a-zA-Z0-9_-]{1,64}$")
    speed: float = Field(default=1, ge=0.5, le=3)


class Batch(BaseModel):
    jobs: list[Job] = Field(min_length=1, max_length=200)


@router.post("/jobs")
async def enqueue(body: Batch):
    if any(j.kind != "voice" for j in body.jobs) and not get_flow_client().connected:
        raise HTTPException(503, "Connect the Flow extension before submitting media jobs.")
    # Validate all inputs before atomically inserting the batch.
    for j in body.jobs:
        if j.kind != "voice":
            try:
                uuid.UUID(j.project_id)
            except ValueError:
                raise HTTPException(400, "Select a valid Flow project.")
        elif not j.template:
            raise HTTPException(400, "Select a voice template.")
        else:
            await tts.get_voice_template(j.template)
    ids = []
    with connection() as db:
        for j in body.jobs:
            jid = str(uuid.uuid4())
            db.execute("INSERT INTO jobs(id,payload,state,created) VALUES(?,?,?,?)", (jid, j.model_dump_json(), "QUEUED", time.time()))
            ids.append(jid)
    return {"ids": ids}


@router.get("/jobs")
async def list_jobs():
    return {"paused": paused, "jobs": [{**r, "payload": json.loads(r["payload"]), "can_resume": r["state"] == "FAILED" and bool(r["remote"]), "remote": None, "files": json.loads(r["files"])} for r in rows()]}


@router.get("/flow-progress")
async def flow_progress():
    """Safe progress summary for the Flow side panel; excludes prompts and URLs."""
    from agent.config import FLOW_GENERATION_MAX_CONCURRENT, FLOW_GENERATION_MIN_INTERVAL_S, FLOW_UNUSUAL_ACTIVITY_COOLDOWN_S
    client = get_flow_client()
    guard = getattr(client, "generation_guard_status", {})
    jobs = []
    for row in rows():
        body = json.loads(row["payload"])
        if body["kind"] == "voice":
            continue
        stage = row["stage"] or row["state"]
        if row["state"] == "QUEUED":
            stage = "PAUSED" if paused else "WAITING_CONNECTION" if not client.connected else "COOLDOWN" if guard.get("cooldown_active") and not row["remote"] else "QUEUED"
        jobs.append({"id": row["id"], "kind": body["kind"], "label": body.get("label", "Scene"),
                     "state": row["state"], "stage": stage, "created": row["created"],
                     "started": row["started"], "updated": row["updated"] or row["created"],
                     "error": row["error"]})
    counts = {key: sum(j["state"] in states for j in jobs) for key, states in (
        ("active", ACTIVE_STATES), ("queued", {"QUEUED"}), ("completed", {"COMPLETED"}),
        ("failed", {"FAILED", "NEEDS_REVIEW"}))}
    # Active/queued jobs first, then recent finished jobs; list size bounded.
    display = sorted(jobs, key=lambda j: (j["state"] not in ACTIVE_STATES, j["state"] != "QUEUED", -j["created"]))[:50]
    return {"connected": client.connected, "paused": paused, "max_concurrent": MEDIA_CONCURRENCY,
            **counts, "jobs": display, "generation_throttle": {
                "max_concurrent": FLOW_GENERATION_MAX_CONCURRENT,
                "min_interval_s": FLOW_GENERATION_MIN_INTERVAL_S,
                "unusual_activity_cooldown_s": FLOW_UNUSUAL_ACTIVITY_COOLDOWN_S, **guard}}


class Pause(BaseModel):
    paused: bool


@router.post("/pause")
async def pause(body: Pause):
    global paused
    with connection() as db:
        db.execute("INSERT OR REPLACE INTO preferences(key,value) VALUES('paused',?)", (json.dumps(body.paused),))
    paused = body.paused
    return {"paused": paused}


class CancelBatch(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=1000)


@router.post("/jobs/cancel")
async def cancel_jobs(body: CancelBatch):
    """Cancel only jobs not claimed by the worker; never interrupt remote work."""
    cancelled = []
    with connection() as db:
        for jid in dict.fromkeys(body.ids):
            result = db.execute("UPDATE jobs SET state='CANCELLED', stage='CANCELLED', updated=?, error=NULL WHERE id=? AND state='QUEUED'", (time.time(), jid))
            if result.rowcount:
                cancelled.append(jid)
    return {"cancelled": cancelled, "skipped": [jid for jid in dict.fromkeys(body.ids) if jid not in cancelled]}


@router.post("/jobs/{jid}/resume")
async def resume(jid: str):
    job = next((r for r in rows() if r["id"] == jid), None)
    if not job:
        raise HTTPException(404, "Job not found")
    if job["state"] != "FAILED" or not job["remote"]:
        raise HTTPException(409, "Only failed jobs with a saved remote result can resume. Uncertain submissions must be checked in Flow first.")
    update(jid, state="QUEUED", error=None)
    return {"ok": True}


@router.get("/jobs/{jid}/files/{index}")
async def file(jid: str, index: int):
    job = next((r for r in rows() if r["id"] == jid), None)
    if not job:
        raise HTTPException(404, "Job not found")
    files = json.loads(job["files"])
    if index < 0 or index >= len(files):
        raise HTTPException(404, "File not found")
    path = Path(files[index]).resolve()
    if not path.is_relative_to(ROOT.resolve()) or not path.is_file():
        raise HTTPException(404, "File not available")
    return FileResponse(path)


def safe_media_url(url):
    parsed = urlparse(url)
    host = parsed.hostname or ""
    if parsed.scheme != "https" or parsed.port not in (None, 443) or parsed.username or not any(host == d or host.endswith("." + d) for d in ("googleusercontent.com", "storage.googleapis.com", "flow-content.google")):
        raise ValueError("Unexpected media host; download blocked")


async def download(url, target):
    """Validate every redirect and write atomically; never regenerate on failure."""
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_suffix(target.suffix + ".part")
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=300)) as session:
            for _ in range(6):
                safe_media_url(url)
                async with session.get(url, allow_redirects=False) as response:
                    if response.status in (301, 302, 303, 307, 308):
                        from urllib.parse import urljoin
                        url = urljoin(url, response.headers["Location"])
                        continue
                    response.raise_for_status()
                    size = 0
                    with part.open("wb") as out:
                        async for chunk in response.content.iter_chunked(262144):
                            size += len(chunk)
                            if size > 512 * 1024 * 1024:
                                raise ValueError("Media exceeds 512 MiB")
                            out.write(chunk)
                    if not size:
                        raise ValueError("Empty media download")
                    kind = "video" if target.suffix == ".mp4" else "image"
                    streams = await validate_media(part, kind)
                    if kind == "image":
                        codec = next(s.get("codec_name") for s in streams if s.get("codec_type") == "video")
                        suffix = {"png": ".png", "mjpeg": ".jpg", "webp": ".webp", "av1": ".avif"}.get(codec)
                        if not suffix:
                            raise ValueError("Unsupported image format")
                        target = target.with_suffix(suffix)
                    part.replace(target)
                    return target
            raise ValueError("Too many media redirects")
    finally:
        part.unlink(missing_ok=True)


async def validate_media(path, kind):
    def probe():
        result = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(path)], capture_output=True, text=True, timeout=30)
        streams = json.loads(result.stdout or "{}").get("streams", [])
        if result.returncode or not any(s.get("codec_type") == ("audio" if kind == "voice" else "video") for s in streams):
            raise ValueError("Downloaded file is not valid media")
        return streams
    return await asyncio.to_thread(probe)


async def process(job):
    jid = job["id"]
    # Claim atomically so a cancelled job cannot start from a stale queue snapshot.
    with connection() as db:
        if not db.execute("UPDATE jobs SET state='RUNNING', stage='STARTING', started=?, updated=?, error=NULL WHERE id=? AND state='QUEUED'", (time.time(), time.time(), jid)).rowcount:
            return
    body = Job.model_validate_json(job["payload"])
    remote = json.loads(job["remote"]) if job["remote"] else None
    from agent.services.browser_lifecycle import flow_started, flow_saved
    if body.kind != "voice":
        flow_started("desktop", jid)
    try:
        if not remote:
            # A crash after this state is persisted is not auto-resubmitted.
            update(jid, state="SUBMITTING", stage="GENERATING_IMAGE" if body.kind == "image" else "SUBMITTING_VIDEO" if body.kind == "video" else "GENERATING_VOICE")
            if body.kind == "image":
                result = await flow.generate_image(flow.GenerateImageRequest(prompt=body.prompt, project_id=body.project_id, image_model=body.image_model, aspect_ratio="IMAGE_ASPECT_RATIO_LANDSCAPE" if body.orientation == "HORIZONTAL" else "IMAGE_ASPECT_RATIO_PORTRAIT"))
                urls = [m.get("image", {}).get("generatedImage", {}).get("fifeUrl") or m.get("image", {}).get("generatedImage", {}).get("imageUri") for m in result.get("media", [])]
                if not urls or not all(urls):
                    raise ValueError("Flow returned no usable image URLs; check the project before generating again")
                remote = {"urls": urls}
            elif body.kind == "video":
                result = await flow.generate_video_omni_text(flow.GenerateOmniFlashTextVideoRequest(prompt=body.prompt, project_id=body.project_id, scene_id=body.scene_id, duration_s=body.duration, aspect_ratio="VIDEO_ASPECT_RATIO_LANDSCAPE" if body.orientation == "HORIZONTAL" else "VIDEO_ASPECT_RATIO_PORTRAIT"))
                workflows = extract_omni_workflows(result)
                if not workflows:
                    raise ValueError("No workflow ID received; check Flow before generating again")
                remote = {"workflows": workflows}
            else:
                template = await tts.get_voice_template(body.template)
                result = await tts.tts_generate(tts.TTSGenerateRequest(text=body.prompt, ref_audio=template.audio_path, ref_text=template.text, speed=body.speed))
                remote = {"audio_path": result.audio_path}
            update(jid, remote=json.dumps(remote), state="RUNNING")
        if body.kind == "video" and not remote.get("urls"):
            update(jid, stage="GENERATING_VIDEO")
            for _ in range(120):
                result = await flow.check_omni_status(flow.CheckOmniStatusRequest(workflows=remote["workflows"], project_id=body.project_id))
                if result.get("done"):
                    remote["urls"] = [w["media"]["url"] for w in result["workflows"]]
                    update(jid, remote=json.dumps(remote))
                    break
                await asyncio.sleep(10)
            else:
                raise TimeoutError("Polling timed out. Resume to check the same video; no new generation is submitted.")
        update(jid, state="DOWNLOADING")
        folder = ROOT / jid
        folder.mkdir(parents=True, exist_ok=True)
        files = []
        if body.kind == "voice":
            import shutil
            source = Path(remote["audio_path"]).resolve()
            if not source.is_relative_to(OUTPUT_DIR.resolve()):
                raise ValueError("Invalid audio output path")
            target = folder / "narration.wav"
            await validate_media(source, "voice")
            await asyncio.to_thread(shutil.copyfile, source, target)
            files.append(str(target))
        else:
            for i, url in enumerate(remote["urls"]):
                target = folder / (f"output_{i+1}.mp4" if body.kind == "video" else f"output_{i+1}.png")
                target = await download(url, target)
                files.append(str(target))
        update(jid, state="COMPLETED", files=json.dumps(files))
        if body.kind != "voice":
            flow_saved("desktop", jid)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        update(jid, state="FAILED", error=str(getattr(exc, "detail", None) or exc)[:1500])


async def run():
    global paused
    with connection() as db:
        preference = db.execute("SELECT value FROM preferences WHERE key='paused'").fetchone()
        paused = json.loads(preference["value"]) if preference else False
    for r in rows():
        if r["state"] in ("RUNNING", "SUBMITTING", "DOWNLOADING"):
            update(r["id"], state="QUEUED" if r["remote"] else "NEEDS_REVIEW", error="Application restarted; saved result will resume, uncertain submissions require review.")
    tasks: dict[str, tuple[asyncio.Task, str]] = {}
    try:
        while True:
            for jid, (task, _) in list(tasks.items()):
                if task.done():
                    try:
                        task.result()
                    except asyncio.CancelledError:
                        pass
                    except Exception:
                        logger.exception("Desktop task failed outside job handler: %s", jid)
                    del tasks[jid]
            if not paused:
                for r in reversed(rows()):
                    if r["state"] != "QUEUED" or r["id"] in tasks:
                        continue
                    kind = json.loads(r["payload"])["kind"]
                    lane = "voice" if kind == "voice" else "media"
                    limit = VOICE_CONCURRENCY if lane == "voice" else MEDIA_CONCURRENCY
                    if sum(active_lane == lane for _, active_lane in tasks.values()) >= limit:
                        continue
                    if lane == "media":
                        client = get_flow_client()
                        if not client.connected:
                            continue
                        # Hold unsubmitted jobs in the durable queue during
                        # cooldown. Saved results may still poll/download.
                        if not r["remote"] and getattr(client, "generation_guard_status", {}).get("cooldown_active"):
                            continue
                    tasks[r["id"]] = (asyncio.create_task(process(r)), lane)
            try:
                from agent.services.browser_lifecycle import close_idle_flow_tabs
                await close_idle_flow_tabs()
            except Exception:
                logger.debug("Flow worker cleanup deferred", exc_info=True)
            await asyncio.sleep(2)
    finally:
        # Leave interrupted state durable. Startup only resumes known remote
        # results; uncertain submissions are never automatically repeated.
        for task, _ in tasks.values():
            task.cancel()
        await asyncio.gather(*(task for task, _ in tasks.values()), return_exceptions=True)


@router.post("/voices/import")
async def import_voice(name: str = Form(...), text: str = Form(...), consent: bool = Form(...), audio: UploadFile = File(...)):
    tts._validate_template_name(name)
    if not consent or not text.strip() or len(text) > 5000:
        raise HTTPException(400, "Provide the sample transcript and confirm voice usage permission.")
    if name in tts._load_templates_meta():
        raise HTTPException(409, "A voice with this name already exists.")
    temp = tts.TEMPLATES_DIR / (str(uuid.uuid4()) + ".upload")
    dest = tts.TEMPLATES_DIR / (name + "_" + uuid.uuid4().hex[:8] + ".wav")
    try:
        tts.TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)
        size = 0
        with temp.open("wb") as out:
            while chunk := await audio.read(262144):
                size += len(chunk)
                if size > 25 * 1024 * 1024:
                    raise HTTPException(413, "Reference audio must be under 25 MiB.")
                out.write(chunk)
        def convert():
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(temp), "-t", "120", "-vn", "-ac", "1", "-ar", "24000", str(dest)], capture_output=True, check=True, timeout=60)
        await asyncio.to_thread(convert)
        await validate_media(dest, "voice")
        meta = tts._load_templates_meta()
        if name in meta:
            raise HTTPException(409, "Voice name already exists.")
        meta[name] = {"name": name, "audio_path": str(dest), "text": text.strip(), "instruct": "Imported reference voice", "duration": tts._wav_duration(str(dest))}
        tts._save_templates_meta(meta)
        return meta[name]
    except Exception as exc:
        logger.exception("Voice import failed: %s", name)
        try:
            dest.unlink(missing_ok=True)
        except OSError:
            logger.warning("Cannot remove failed voice file: %s", dest)
        if isinstance(exc, HTTPException):
            raise
        if isinstance(exc, subprocess.CalledProcessError):
            detail = (exc.stderr or b"").decode("utf-8", errors="replace")[-1200:]
            raise HTTPException(400, f"FFmpeg could not decode this audio: {detail}") from exc
        if isinstance(exc, subprocess.TimeoutExpired):
            raise HTTPException(408, "Audio conversion or validation timed out. Try a short 3-10 second sample.") from exc
        if isinstance(exc, FileNotFoundError):
            raise HTTPException(500, f"Required file or executable not found: {exc}. Check FFmpeg and FFprobe in the backend PATH.") from exc
        if isinstance(exc, OSError):
            raise HTTPException(500, f"Cannot write voice files in {tts.TEMPLATES_DIR}: {exc}") from exc
        raise HTTPException(400, f"Cannot import audio: {exc}") from exc
    finally:
        try:
            temp.unlink(missing_ok=True)
        except OSError:
            logger.warning("Cannot remove temporary upload: %s", temp)


@router.get("/diagnostics")
async def diagnostics():
    import shutil
    from agent.services.tts import PYTHON_BIN
    def check_tts():
        try:
            r = subprocess.run([PYTHON_BIN, "-c", "import omnivoice, torch, torchaudio"], capture_output=True, timeout=25)
            return r.returncode == 0
        except Exception:
            return False
    return {"ffmpeg": bool(shutil.which("ffmpeg")), "ffprobe": bool(shutil.which("ffprobe")), "tts_python": PYTHON_BIN, "tts_installed": await asyncio.to_thread(check_tts), "output_dir": str(ROOT.resolve())}
