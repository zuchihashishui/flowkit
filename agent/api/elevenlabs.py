"""ID-based local API and WebSocket transport for the ElevenLabs extension."""
import ipaddress
import json
import re
from typing import Literal
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from agent.services.elevenlabs_bridge import bridge, BridgeError, MAX_AUDIO_BYTES, MAX_TEXT_CHARACTERS, DEFAULT_MODEL

from agent.api.workflow import Scoped, inputs
from agent.services import workflow_scope as scope

router = APIRouter(prefix='/elevenlabs', tags=['elevenlabs'])

class TextBody(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TEXT_CHARACTERS)
    max_chunk_characters: int = Field(default=3000, ge=100, le=3000, strict=True)

class JobBody(TextBody, Scoped):
    title: str = Field(default='', max_length=200)
    model: str = Field(default=DEFAULT_MODEL, max_length=100)

class ControlBody(BaseModel):
    action: Literal['pause', 'resume', 'review']
    reviewed: bool = False

class RetryBody(BaseModel):
    reviewed: bool = False

@router.get('/status')
async def status():
    return bridge.status()

@router.get('/jobs')
async def jobs(project_id: str | None = None, video_id: str | None = None, unassigned: bool = False):
    return {'jobs': scope.select(scope.annotate(bridge, 'elevenlabs', bridge.jobs(dict(project_id=project_id, video_id=video_id, unassigned=unassigned))), project_id, video_id, unassigned), 'settings': bridge.settings()}

@router.get('/jobs/{job_id}')
async def job(job_id: str):
    try:
        return bridge.job(job_id)
    except KeyError:
        raise HTTPException(404, 'Job not found.') from None

@router.post('/preview')
async def preview(body: TextBody):
    try:
        return bridge.preview(body.text, body.max_chunk_characters)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error

@router.post('/jobs')
async def enqueue(body: JobBody):
    try:
        return bridge.enqueue(body.text, body.title, body.model, body.max_chunk_characters, await inputs(body))
    except ValueError as error:
        raise HTTPException(422, str(error)) from error

@router.post('/control')
async def control(body: ControlBody):
    try:
        return await bridge.control(body.action, body.reviewed)
    except (BridgeError, TimeoutError) as error:
        raise HTTPException(409, str(error) or 'Extension did not respond.') from error

@router.post('/probe')
async def probe():
    try:
        return await bridge.probe()
    except (BridgeError, TimeoutError) as error:
        raise HTTPException(409, str(error) or 'Extension did not respond.') from error

@router.post('/jobs/{job_id}/cancel')
async def cancel(job_id: str):
    try:
        return bridge.cancel(job_id)
    except KeyError:
        raise HTTPException(404, 'Job not found.') from None

@router.post('/jobs/{job_id}/retry')
async def retry(job_id: str, body: RetryBody):
    try:
        return bridge.retry(job_id, body.reviewed)
    except KeyError:
        raise HTTPException(404, 'Job not found.') from None
    except BridgeError as error:
        raise HTTPException(409, str(error)) from error

@router.post('/jobs/{job_id}/recover')
async def recover(job_id: str, body: RetryBody):
    try:
        return await bridge.recover_downloads(job_id, body.reviewed)
    except KeyError:
        raise HTTPException(404, 'Job not found.') from None
    except BridgeError as error:
        raise HTTPException(409, str(error)) from error

@router.get('/audio/{job_id}/{chunk_index}')
async def audio(job_id: str, chunk_index: str):
    try:
        path = bridge.audio_path(job_id, chunk_index)
    except KeyError:
        raise HTTPException(404, 'Audio not found.') from None
    return FileResponse(path, filename=path.name)


def trusted_websocket(websocket):
    try:
        local = ipaddress.ip_address(websocket.client.host).is_loopback
    except (ValueError, AttributeError):
        return False
    # Browser pages cannot impersonate a Chrome extension Origin. Reject absent
    # origins as this endpoint exists only for our extension, not arbitrary clients.
    return local and bool(re.fullmatch(r'chrome-extension://[a-p]{32}', websocket.headers.get('origin', '')))


@router.websocket('/ws')
async def websocket_endpoint(websocket: WebSocket):
    if not trusted_websocket(websocket):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    try:
        await bridge.connect(websocket)
    except BridgeError:
        await websocket.close(code=1008)
        return
    try:
        while True:
            raw = await websocket.receive_text()
            if len(raw) > ((MAX_AUDIO_BYTES + 2) // 3) * 4 + 100_000:
                await websocket.close(code=1009)
                break
            try:
                message = json.loads(raw)
            except (ValueError, TypeError):
                await websocket.close(code=1003)
                break
            await bridge.receive(websocket, message)
    except WebSocketDisconnect:
        pass
    finally:
        await bridge.disconnect(websocket)
