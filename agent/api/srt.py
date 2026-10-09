from uuid import UUID
from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from agent.services.srt_service import service, MAX_JSON

from agent.api.workflow import Scoped, inputs, context
from agent.services import workflow_scope as scope

router = APIRouter(prefix='/srt', tags=['srt'])

class Job(Scoped):
    source_id: UUID
    prompt: str | None = Field(default=None, min_length=1, max_length=100000)
    model: str = Field(default='GPT-6 Astra', min_length=1, max_length=100)
    timeout: int = Field(default=1800, ge=60, le=1800)
    duration_seconds: float | None = Field(default=None, gt=0, le=86400)

@router.get('/status')
async def status(project_id: str | None = None, video_id: str | None = None, unassigned: bool = False):
    result = service.status(dict(project_id=project_id, video_id=video_id, unassigned=unassigned))
    for key, kind in [('jobs','srt'),('sources','json')]:
        result[key] = scope.select(scope.annotate(service, kind, result[key]), project_id, video_id, unassigned)
    return result

@router.post('/import')
async def import_json(file: UploadFile = File(...), project_id: str | None = Form(None), video_id: str | None = Form(None)):
    try:
        if not (file.filename or '').lower().endswith('.json'):
            raise ValueError('Choose a JSON file.')
        ctx = await context(project_id, video_id)
        return service.import_bytes(await file.read(MAX_JSON + 1), file.filename, ctx)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    finally:
        await file.close()

@router.post('/jobs')
async def enqueue(body: Job):
    try:
        kind = 'json' if any(s['id'] == str(body.source_id) for s in service.sources()) else 'whisperx'
        ctx = await inputs(body, [scope.ref(kind, body.source_id)])
        from agent.services.project_settings import snapshot
        settings=await snapshot(ctx)
        prompt=body.prompt if body.prompt is not None else settings.get('production',{}).get('srt',{}).get('instructions','')
        if not prompt.strip() or not body.model.strip():raise ValueError('Enter a prompt and model name, or save SRT instructions in Project Settings.')
        return service.enqueue(str(body.source_id), prompt, body.model.strip(), body.timeout, ctx, duration_seconds=body.duration_seconds, project_settings=settings)
    except (ValueError, KeyError, FileNotFoundError) as e:
        raise HTTPException(409, str(e)) from e

@router.post('/jobs/{jid}/cancel')
async def cancel(jid: UUID):
    return service.cancel(str(jid))

@router.get('/jobs/{jid}/result')
async def result(jid: UUID):
    try:
        return FileResponse(service.result_path(str(jid)), media_type='application/x-subrip', filename='subtitles.srt')
    except ValueError as e:
        raise HTTPException(404, str(e)) from e

@router.get('/jobs/{jid}/preview')
async def preview(jid: UUID):
    try:
        return {'text': service.result_path(str(jid)).read_text(encoding='utf-8')[:20000]}
    except ValueError as e:
        raise HTTPException(404, str(e)) from e


class CheckSource(Scoped):
    source_id: UUID
    duration_seconds: float | None = Field(default=None, gt=0, le=86400)


@router.post('/analyze')
async def analyze(body: CheckSource):
    try:
        kind = 'json' if any(s['id'] == str(body.source_id) for s in service.sources()) else 'whisperx'
        await inputs(body, [scope.ref(kind, body.source_id)])
        return service.analyze(str(body.source_id), body.duration_seconds)['report']
    except (ValueError, KeyError, FileNotFoundError) as error:
        raise HTTPException(422, str(error)) from error


@router.get('/jobs/{jid}/quality')
async def quality(jid: UUID):
    try:
        return service.quality(str(jid))
    except ValueError as error:
        raise HTTPException(404, str(error)) from error


class Approval(BaseModel):
    reviewed: bool


@router.post('/jobs/{jid}/approve')
async def approve(jid: UUID, body: Approval):
    if not body.reviewed:
        raise HTTPException(422, 'Review the quality report first.')
    try:
        return service.approve_quality(str(jid))
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
