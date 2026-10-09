from typing import Literal
from uuid import UUID
import shutil
from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from agent.services.assembly_service import service

from agent.api.workflow import Scoped, inputs, context
from agent.services import workflow_scope as scope

router = APIRouter(prefix='/assembly', tags=['assembly'])

class Plan(Scoped):
    title: str = Field(default='Untitled video', min_length=1, max_length=200)
    srt_id: UUID
    audio_id: UUID
    image_ids: list[UUID] = Field(default_factory=list, max_length=1000)
    video_ids: list[UUID] = Field(default_factory=list, max_length=1000)
    visual_mode: Literal['images', 'mixed'] = 'images'
    clip_end: Literal['freeze', 'loop'] = 'freeze'
    mapping: dict[str, UUID | None] = Field(default_factory=dict, max_length=3000)
    mapping_mode: Literal['number', 'order'] = 'number'
    size: Literal['1080p', '720p', 'vertical'] = '1080p'
    fps: Literal[24, 30, 60] = 30
    fit: Literal['fit', 'crop'] = 'fit'
    image_motion: Literal['none', 'zoom_in', 'zoom_out'] = 'none'
    subtitles: Literal['burn', 'soft', 'off'] = 'off'
    font: str = Field(default='Yu Gothic', min_length=1, max_length=80, pattern=r'^[\w .-]+$')

class Source(Scoped):
    kind: Literal['srt', 'audio']
    source_id: UUID

@router.get('/status')
async def status(project_id: str | None = None, video_id: str | None = None, unassigned: bool = False):
    output_directory = None
    if project_id and video_id and not unassigned:
        from agent.services.video_files import folders
        await context(project_id, video_id)
        output_directory = (await folders(project_id, video_id))['folders']['exports']
    return {'workspace_version': 1, 'output_directory': output_directory, 'production_version': 1, 'mixed_media_version': 1, 'image_motion_version': 1, 'assets': scope.select(scope.annotate(service, 'asset', service.assets()), project_id, video_id, unassigned), 'jobs': scope.select(scope.annotate(service, 'assembly', service.jobs(dict(project_id=project_id, video_id=video_id, unassigned=unassigned))), project_id, video_id, unassigned), 'ffmpeg': bool(shutil.which('ffmpeg')), 'ffprobe': bool(shutil.which('ffprobe'))}


class ProjectSources(Scoped):
    visual_mode: Literal['images', 'mixed'] = 'mixed'


@router.post('/project-sources')
async def project_sources(body: ProjectSources):
    from agent.services.assembly_sources import load_project_sources
    try:
        ctx = await context(body.project_id, body.video_id)
        if not ctx.get('video_id'):
            raise ValueError('Select a project and video first.')
        return await load_project_sources(service, ctx, body.visual_mode)
    except (ValueError, OSError) as e:
        raise HTTPException(409, str(e)) from e

@router.post('/import/{kind}')
async def import_file(kind: Literal['srt', 'audio', 'image', 'video'], file: UploadFile = File(...), project_id: str | None = Form(None), video_id: str | None = Form(None)):
    try:
        return await service.import_upload(kind, file, await context(project_id, video_id))
    except (ValueError, UnicodeError, OSError) as e:
        raise HTTPException(422, str(e)) from e
    finally:
        await file.close()

@router.post('/source')
async def use_source(body: Source):
    try:
        from agent.api.whisperx import service as wx
        parent = scope.ref('srt', body.source_id) if body.kind == 'srt' else scope.audio_ref(wx, str(body.source_id))
        return await service.use_source(body.kind, str(body.source_id), await inputs(body, [parent]))
    except (ValueError, KeyError, OSError) as e:
        raise HTTPException(409, str(e)) from e

@router.post('/preview')
async def preview(body: Plan):
    try:
        ctx = await inputs(body, [scope.ref('asset', i) for i in [body.audio_id,body.srt_id,*body.image_ids,*body.video_ids]])
        from agent.services.production_settings import apply_stage
        body = await apply_stage(body, 'assembly', ctx)
        return service.plan(body.model_dump(mode='json'))
    except (ValueError, UnicodeError, OSError) as e:
        raise HTTPException(409, str(e)) from e

@router.post('/jobs')
async def enqueue(body: Plan):
    try:
        ctx = await inputs(body, [scope.ref('asset', i) for i in [body.audio_id,body.srt_id,*body.image_ids,*body.video_ids]])
        from agent.services.production_settings import apply_stage
        body = await apply_stage(body, 'assembly', ctx)
        from agent.services.assembly_preflight import check
        report = await check(service, body.model_dump(mode='json'))
        if report['blocked']:
            raise ValueError('Resolve missing or unreadable files in Check files & preview before rendering.')
        return service.enqueue(body.model_dump(mode='json'), ctx)
    except (ValueError, UnicodeError, OSError) as e:
        raise HTTPException(409, str(e)) from e

@router.post('/jobs/{jid}/cancel')
async def cancel(jid: UUID):
    return await service.cancel(str(jid))

@router.get('/jobs/{jid}/video')
async def video(jid: UUID):
    try:
        return FileResponse(service.result_path(str(jid)), media_type='video/mp4', filename='video.mp4')
    except ValueError as e:
        raise HTTPException(404, str(e)) from e

@router.get('/clips/{aid}/video')
async def clip(aid: UUID):
    try:
        asset = service.asset(str(aid), 'video')
        return FileResponse(service.path(asset), filename=asset['title'])
    except ValueError as e:
        raise HTTPException(404, str(e)) from e

@router.get('/images/{aid}/thumbnail')
async def thumbnail(aid: UUID):
    try:
        asset = service.asset(str(aid), 'image')
        return FileResponse(service.thumbnail_path(asset), media_type='image/jpeg')
    except ValueError as e:
        raise HTTPException(404, str(e)) from e


class SceneMedia(Scoped):
    srt_id: UUID
    visual_mode: Literal['images','mixed'] = 'images'


@router.post('/scene-media')
async def scene_media(body: SceneMedia):
    from agent.services.assembly_sources import load_scene_media
    try:
        ctx = await inputs(body, [scope.ref('asset',body.srt_id)])
        return await load_scene_media(service, ctx, str(body.srt_id), body.visual_mode)
    except (ValueError, OSError) as e:
        raise HTTPException(409,str(e)) from e


@router.post('/preflight')
async def preflight(body: Plan):
    from agent.services.assembly_preflight import check
    try:
        ctx = await inputs(body, [scope.ref('asset',i) for i in [body.audio_id,body.srt_id,*body.image_ids,*body.video_ids]])
        from agent.services.production_settings import apply_stage
        body = await apply_stage(body, 'assembly', ctx)
        return await check(service, body.model_dump(mode='json'))
    except (ValueError, OSError) as e:
        raise HTTPException(409,str(e)) from e


@router.post('/jobs/{jid}/resume')
async def resume(jid: UUID, body: Scoped):
    try:
        await inputs(body, [scope.ref('assembly',jid)])
        return service.resume(str(jid))
    except (ValueError, OSError) as e:
        raise HTTPException(409,str(e)) from e
