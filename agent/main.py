"""Flow Kit — FastAPI + WebSocket server entry point."""
import asyncio
import json
import logging
import os
import sys
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import websockets
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from agent.config import API_HOST, API_PORT, WS_HOST, WS_PORT
from agent.db.schema import init_db, close_db
from agent.api.characters import router as characters_router
from agent.api.projects import router as projects_router
from agent.api.videos import router as videos_router
from agent.api.scenes import router as scenes_router
from agent.api.requests import router as requests_router
from agent.api.flow import router as flow_router
from agent.api.reviews import router as reviews_router
from agent.api.tts import router as tts_router
from agent.api.materials import router as materials_router
from agent.api.music import router as music_router
from agent.api.models import router as models_router
from agent.api.providers import router as providers_router
from agent.api.active_project import router as active_project_router
from agent.worker.processor import get_worker_controller
from agent.services.flow_client import get_flow_client
from agent.services.event_bus import event_bus
from agent.sdk import init_sdk
from agent.api import desktop, storyboard, chatgpt, elevenlabs, whisperx, srt, assembly, workflow, production, maintenance

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger(__name__)


def _studio_version() -> str:
    """Capture this process's source version, not whatever is later on disk."""
    try:
        package = json.loads((_SOURCE_ROOT / "desktop" / "package.json").read_text(encoding="utf-8"))
        version = package.get("version")
        return version if isinstance(version, str) and version else "unknown"
    except (OSError, ValueError, AttributeError):
        return "unknown"


_SOURCE_ROOT = Path(__file__).resolve().parent.parent
_STUDIO_VERSION = _studio_version()
_RUNTIME_IDENTITY = {
    "pid": os.getpid(),
    "root": str(_SOURCE_ROOT),
    "python": sys.executable,
    "started_at": datetime.now(timezone.utc).isoformat(),
}


# ─── WebSocket Server for Extension ─────────────────────────

async def ws_handler(websocket):
    """Handle a Chrome extension WebSocket connection."""
    client = get_flow_client()
    client.set_extension(websocket)
    logger.info("Extension connected from %s", websocket.remote_address)

    # Send callback secret so extension can authenticate HTTP callbacks
    await websocket.send(json.dumps({"type": "callback_secret", "secret": _CALLBACK_SECRET}))

    try:
        async for raw in websocket:
            try:
                data = json.loads(raw)
                await client.handle_message(data, websocket)
            except json.JSONDecodeError:
                logger.warning("Invalid JSON from extension")
            except Exception as e:
                logger.exception("Error handling extension message: %s", e)
    except websockets.ConnectionClosed:
        pass
    finally:
        client.clear_extension(websocket)
        logger.info("Extension disconnected")


async def run_ws_server():
    """Run WebSocket server for extension connections."""
    async with websockets.serve(ws_handler, WS_HOST, WS_PORT):
        logger.info("WebSocket server listening on ws://%s:%d", WS_HOST, WS_PORT)
        await asyncio.Future()  # run forever


# ─── FastAPI App ─────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    from agent.services.workspace_delete_files import recover as recover_workspace_deletions
    await asyncio.to_thread(recover_workspace_deletions)

    # Load custom materials from DB into in-memory registry
    from agent.db.crud import list_materials as db_list_materials
    from agent.materials import register_material, _BUILTIN_IDS
    try:
        custom_materials = await db_list_materials()
        for m in custom_materials:
            if m["id"] not in _BUILTIN_IDS:
                register_material(m)
                logger.info("Loaded custom material from DB: %s", m["id"])
    except Exception as e:
        logger.warning("Failed to load custom materials: %s", e)

    ops = init_sdk(get_flow_client())
    logger.info("SDK initialized (OperationService ready)")
    logger.info("Flow Kit starting on %s:%d", API_HOST, API_PORT)

    controller = get_worker_controller()

    # Uvicorn owns process signals; overriding SIGTERM prevented server shutdown.

    # Start background tasks
    ws_task = asyncio.create_task(run_ws_server())
    worker_task = asyncio.create_task(controller.start())
    desktop_task = asyncio.create_task(desktop.run())
    storyboard_task = asyncio.create_task(storyboard.run())
    from agent.services import chatgpt_gateway
    chatgpt_task = asyncio.create_task(chatgpt_gateway.run())
    from agent.services import elevenlabs_bridge
    elevenlabs_task = asyncio.create_task(elevenlabs_bridge.run())
    from agent.services.whisperx_service import service as whisperx_service
    whisperx_task = asyncio.create_task(whisperx_service.run())
    from agent.services.srt_service import service as srt_service
    srt_task = asyncio.create_task(srt_service.run())
    from agent.services.assembly_service import service as assembly_service
    assembly_task = asyncio.create_task(assembly_service.run())
    from agent.services import video_files
    video_files_task = asyncio.create_task(video_files.run())
    logger.info("WS server + worker started")

    from agent.services.loop_watchdog import LoopWatchdog
    with LoopWatchdog():
        yield

    controller.request_shutdown()
    await controller.drain()
    ws_task.cancel()
    worker_task.cancel()
    desktop_task.cancel()
    storyboard_task.cancel()
    chatgpt_task.cancel()
    elevenlabs_task.cancel()
    whisperx_task.cancel()
    srt_task.cancel()
    assembly_task.cancel()
    video_files_task.cancel()
    await asyncio.gather(ws_task, worker_task, desktop_task, storyboard_task, chatgpt_task, elevenlabs_task, whisperx_task, srt_task, assembly_task, video_files_task, return_exceptions=True)
    await close_db()
    logger.info("Flow Kit stopped")


app = FastAPI(title="Flow Kit", version="1.3.1", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_GENERATION_PATHS = {
    "/api/flow/generate-image",
    "/api/flow/generate-video",
    "/api/flow/generate-video-refs",
    "/api/flow/generate-video-omni",
    "/api/flow/generate-video-omni-text",
    "/api/flow/edit-image",
}


@app.middleware("http")
async def elevenlabs_local_mutations(request: Request, call_next):
    # Paid jobs are issued by the local Electron process/CLI, never a web origin.
    if request.url.path.startswith(('/api/elevenlabs/', '/api/whisperx/', '/api/srt/', '/api/assembly/')) and request.method not in ('GET', 'HEAD', 'OPTIONS') and request.headers.get('origin'):
        return JSONResponse({'detail': 'Browser HTTP origins cannot submit ElevenLabs jobs. Use the local Desktop bridge.'}, status_code=403)
    return await call_next(request)


@app.middleware("http")
async def flow_caller_observability(request: Request, call_next):
    """Attribute generation submits without logging prompts, media or secrets."""
    response = await call_next(request)
    if request.method == "POST" and request.url.path in _GENERATION_PATHS:
        caller = (request.headers.get("x-flowkit-caller") or "unknown")[:80]
        logger.info(
            "Flow generation request caller=%s path=%s status=%s",
            caller,
            request.url.path,
            response.status_code,
        )
    return response


@app.middleware("http")
async def backup_write_guard(request, call_next):
    from agent.services.studio_backup import is_backing_up
    if request.method not in {"GET", "HEAD", "OPTIONS"} and is_backing_up():
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=409, content={"detail":"Backup in progress. Wait for it to finish before changing data or starting jobs."})
    return await call_next(request)


app.include_router(characters_router, prefix="/api")
app.include_router(projects_router, prefix="/api")
app.include_router(videos_router, prefix="/api")
app.include_router(scenes_router, prefix="/api")
app.include_router(requests_router, prefix="/api")
app.include_router(flow_router, prefix="/api")
app.include_router(reviews_router, prefix="/api")
app.include_router(tts_router, prefix="/api")
app.include_router(materials_router, prefix="/api")
app.include_router(music_router, prefix="/api")
app.include_router(models_router)
app.include_router(providers_router)
app.include_router(active_project_router)
app.include_router(desktop.router, prefix="/api")
app.include_router(storyboard.router, prefix="/api")
app.include_router(chatgpt.router, prefix="/api")
app.include_router(elevenlabs.router, prefix="/api")
app.include_router(whisperx.router, prefix="/api")
app.include_router(srt.router, prefix="/api")
app.include_router(assembly.router, prefix="/api")
app.include_router(workflow.router, prefix="/api")
app.include_router(production.router, prefix="/api")
app.include_router(maintenance.router, prefix="/api")


import secrets as _secrets
_CALLBACK_SECRET = _secrets.token_urlsafe(32)


@app.post("/api/ext/callback")
async def ext_callback(request: Request):
    """HTTP callback for extension to deliver API responses.

    Replaces ws.send() for response delivery — immune to WS disconnect.
    Extension POSTs {id, status, data, error} here instead of sending via WS.
    Requires X-Callback-Secret header matching the secret sent to extension on WS connect.
    """
    data = await request.json()
    client = get_flow_client()
    req_id = data.get("id")
    logger.info("ext/callback: id=%s pending=%d match=%s",
                str(req_id)[:8] if req_id else "none",
                len(client._pending),
                "yes" if req_id and req_id in client._pending else "no")
    if req_id and req_id in client._pending:
        future = client._pending[req_id]
        try:
            future.set_result(data)
        except asyncio.InvalidStateError:
            pass
        return {"ok": True}
    return {"ok": False, "reason": "no matching pending request"}


@app.get("/health")
async def health():
    client = get_flow_client()
    return {
        "status": "ok",
        "service": "flowkit-backend",
        "version": app.version,
        "studio_version": _STUDIO_VERSION,
        "runtime": dict(_RUNTIME_IDENTITY),
        "studio_api": 3,
        "studio_features": {
            "project_video_sources": True,
            "project_single_video": False,
            "project_multi_video": True,
            "project_provider_urls": True,
            "production_workspace": True,
            "image_motion": True,
            "elevenlabs_native_download_files": True,
            "elevenlabs_unlimited_native_audio": True,
            "elevenlabs_recover_downloads": True,
            "elevenlabs_safe_pre_submit_failures": True,
            "elevenlabs_auto_prepare_tab": True,
        },
        "extension_connected": client.connected,
        "ws": client.ws_stats,
    }


# ─── Dashboard WebSocket ──────────────────────────────────────

@app.websocket("/ws/dashboard")
async def dashboard_ws(websocket: WebSocket):
    """WebSocket endpoint for dashboard clients (Chrome extension side panel)."""
    # Reject cross-origin connections (only allow localhost)
    origin = (websocket.headers.get("origin") or "").lower()
    if origin and not any(origin.startswith(p) for p in (
        "http://127.0.0.1", "http://localhost", "chrome-extension://",
    )):
        await websocket.close(code=4003, reason="Origin not allowed")
        return
    await websocket.accept()

    q = event_bus.subscribe()
    try:
        # Send initial snapshot
        client = get_flow_client()
        controller = get_worker_controller()
        from agent.db import crud
        pending_requests = await crud.list_requests(status="PENDING")
        processing_requests = await crud.list_requests(status="PROCESSING")
        snapshot = {
            "type": "snapshot",
            "health": {
                "status": "ok",
                "extension_connected": client.connected,
            },
            "requests": pending_requests + processing_requests,
            "worker": {
                "active": controller.active_count,
                "slots": max(0, 5 - controller.active_count),
            },
        }
        await websocket.send_text(json.dumps(snapshot))

        # Forward events from event_bus to this client
        while True:
            try:
                msg = await asyncio.wait_for(q.get(), timeout=30.0)
                await websocket.send_text(msg)
            except asyncio.TimeoutError:
                # Send keepalive ping
                await websocket.send_text(json.dumps({"type": "ping"}))
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.debug("Dashboard WS client disconnected: %s", e)
    finally:
        event_bus.unsubscribe(q)


if __name__ == "__main__":
    from agent.server_runtime import run_server
    run_server("agent.main:app", host=API_HOST, port=API_PORT,
               reload=os.environ.get("GLA_RELOAD", "0") == "1")
