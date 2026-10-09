"""Local WhisperX jobs, using completed ElevenLabs merged audio by ID."""
from typing import Literal
from uuid import UUID
from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from agent.services.whisperx_service import service
from agent.services.transcript_split import FILES

from agent.api.workflow import Scoped, inputs, context
from agent.services import workflow_scope as scope

router = APIRouter(prefix='/whisperx', tags=['whisperx'])

class Options(BaseModel):
    model: Literal['tiny','base','small','medium','large-v2','large-v3'] = 'large-v3'
    device: Literal['auto','cpu','cuda'] = 'cuda'
    language: str = Field(default='', pattern=r'^([a-z]{2,3})?$')
    batch_size: int = Field(default=8, ge=1, le=32, strict=True)
    video_duration_seconds: float = Field(default=100, ge=0, le=86400, allow_inf_nan=False)

class Job(Options, Scoped):
    source_id: UUID

class Settings(Options):
    auto: bool = False

@router.get('/status')
def status(project_id: str | None = None, video_id: str | None = None, unassigned: bool = False):
    jobs = scope.select(scope.annotate(service, 'whisperx', service.jobs(dict(project_id=project_id, video_id=video_id, unassigned=unassigned))), project_id, video_id, unassigned)
    current = next((j for j in jobs if j['state']=='RUNNING'), None) or next((j for j in jobs if j['state']=='QUEUED'), None) or (jobs[0] if jobs else None)
    return {'transcript_split_version':1, 'settings':service.settings(), 'jobs':jobs,
            'active_id':service.active_id, 'worker':{'running':service.loop_running, 'error':service.queue_error},
            'activity_log':service.activity_log(current['id']) if current else None,
            'imported_sources':scope.select(scope.annotate(service, 'audio', service.imported_sources()), project_id, video_id, unassigned)}


@router.post('/import')
async def import_audio(file: UploadFile = File(...), project_id: str | None = Form(None), video_id: str | None = Form(None)):
    try:
        return await service.import_audio(file, await context(project_id, video_id))
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    finally:
        await file.close()

@router.post('/check')
async def check():
    return await service.check()

@router.post('/settings')
async def settings(body: Settings):
    return service.configure(body.model_dump())

@router.post('/jobs')
async def enqueue(body: Job):
    try:
        parent = scope.audio_ref(service, str(body.source_id))
        service.resolve_source(str(body.source_id))
        owner = service if parent['kind'] == 'audio' else service.source
        parent_scope = {'project_id': None, 'video_id': None}
        if hasattr(owner, 'db'):
            with owner.db() as db:
                parent_scope = scope.ownership(db, parent['kind'], str(body.source_id))
        ctx = await inputs(body, [parent], [parent_scope])
        from agent.services.production_settings import apply_stage
        body = await apply_stage(body, 'whisperx', ctx)
        return service.enqueue(str(body.source_id), body.model_dump(exclude={'source_id','project_id','video_id'}), context=ctx)
    except (KeyError, ValueError, FileNotFoundError) as error:
        raise HTTPException(409, str(error)) from error

@router.post('/jobs/{jid}/cancel')
async def cancel(jid: UUID):
    try:
        return await service.cancel(str(jid))
    except KeyError as error:
        raise HTTPException(404, str(error)) from error


@router.post('/jobs/{jid}/retry')
async def retry(jid: UUID, body: Scoped):
    try:
        service.job(str(jid))
        with service.db() as db:
            owner = scope.ownership(db, 'whisperx', str(jid))
        await inputs(body, [scope.ref('whisperx', jid)], [owner])
        return service.retry(str(jid))
    except KeyError as error:
        raise HTTPException(404, str(error)) from error
    except (ValueError, OSError) as error:
        raise HTTPException(409, str(error)) from error

@router.get('/jobs/{jid}/result')
@router.get('/jobs/{jid}/result/{variant}')
async def result(jid: UUID, variant: Literal['full','video','image'] = 'full'):
    try:
        return FileResponse(service.result_path(str(jid), variant), media_type='application/json', filename=FILES[variant])
    except (KeyError, ValueError) as error:
        raise HTTPException(404, str(error)) from error

@router.get('/jobs/{jid}/preview')
@router.get('/jobs/{jid}/preview/{variant}')
async def preview(jid: UUID, variant: Literal['full','video','image'] = 'full'):
    import json
    try:
        data = json.loads(service.result_path(str(jid), variant).read_text(encoding='utf-8'))
        return {'filename':FILES[variant], 'language': data.get('language'), 'metadata': data.get('metadata'),
                'word_count': len(data['word_segments']), 'segment_count': len(data['segments']),
                'words': data['word_segments'][:200]}
    except (KeyError, ValueError) as error:
        raise HTTPException(404, str(error)) from error


class SplitRequest(BaseModel):
    video_duration_seconds: float = Field(default=100, ge=0, le=86400, allow_inf_nan=False)


@router.post('/jobs/{jid}/split')
async def split_saved(jid: UUID, body: SplitRequest):
    try:
        await service.split_saved(str(jid), body.video_duration_seconds)
        return service.job(str(jid))
    except (ValueError, KeyError, FileNotFoundError) as error:
        raise HTTPException(409, str(error)) from error
