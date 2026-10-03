"""Video ownership, explicit legacy assignment and manual stage handoffs."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Literal
from agent.db.schema import get_db
from agent.services import workflow_scope as scope

router = APIRouter(prefix='/workflow', tags=['workflow'])


class ProjectSelection(BaseModel):
    project_id: str = Field(min_length=1, max_length=100)


@router.post('/project')
async def select_project(body: ProjectSelection):
    from agent.services.project_workspace import ensure
    video = await ensure(body.project_id)
    return {'project_id': body.project_id, 'video_id': video['id'], 'title': video['title'], 'protocol': 2}


class Scoped(BaseModel):
    project_id: str | None = Field(default=None, max_length=100)
    video_id: str | None = Field(default=None, max_length=100)


class Resource(Scoped):
    kind: Literal['elevenlabs', 'audio', 'whisperx', 'json', 'srt', 'asset', 'assembly']
    id: str = Field(min_length=1, max_length=100)


async def context(project_id=None, video_id=None):
    if not project_id and not video_id:
        return {}
    if project_id and not video_id:
        from agent.services.project_workspace import ensure
        video_id = (await ensure(project_id))['id']
    if not project_id or not video_id:
        raise HTTPException(422, 'Select a project in Projects first.')
    db = await get_db()
    row = await (await db.execute('SELECT v.project_id FROM video v JOIN project p ON p.id=v.project_id WHERE v.id=? AND p.status!=?', (video_id, 'DELETED'))).fetchone()
    if not row or row['project_id'] != project_id:
        raise HTTPException(409, 'The selected video does not belong to this project. Refresh Projects.')
    return {'project_id': project_id, 'video_id': video_id}


async def inputs(body, sources=(), parents=None):
    ctx = await context(body.project_id, body.video_id)
    try:
        resolved = scope.resolve(ctx, sources, parents)
        # The caller may omit ownership and inherit it from a source. Validate
        # that inherited owner too (a project may have been deleted meanwhile).
        return await context(resolved.get('project_id'), resolved.get('video_id'))
    except ValueError as e:
        raise HTTPException(409, str(e)) from e


@router.get('/resources')
async def resources(project_id: str | None = None, video_id: str | None = None, unassigned: bool = False):
    if video_id:
        await context(project_id, video_id)
    items = scope.select(scope.catalog(), project_id, video_id, unassigned)
    db = await get_db()
    links = await (await db.execute('''SELECT ds.kind,ds.source_id,d.video_id,COUNT(s.id) AS scene_count
        FROM document_source ds JOIN script_document d ON d.id=ds.document_id
        LEFT JOIN script_segment s ON s.document_id=d.id GROUP BY ds.document_id''')).fetchall()
    mapping = {(r['kind'], r['source_id']): dict(r) for r in links}
    for item in items:
        item['scenes'] = mapping.get((item['resource_kind'], item['id']))
    return {'resources': items,
            'manual_stages': True, 'protocol': 1}


@router.post('/assignment-preview')
async def assignment_preview(body: Resource):
    ctx = await context(body.project_id, body.video_id)
    if not ctx:
        raise HTTPException(422, 'Select the destination project first.')
    try:
        return {'resources': scope.assignment_plan(body.kind, body.id, ctx)}
    except ValueError as e:
        raise HTTPException(409, str(e)) from e


@router.post('/assign')
async def assign(body: Resource):
    ctx = await context(body.project_id, body.video_id)
    if not ctx:
        raise HTTPException(422, 'Select the destination project first.')
    try:
        return scope.assign(body.kind, body.id, ctx)
    except ValueError as e:
        raise HTTPException(409, str(e)) from e


@router.post('/import-scenes')
async def import_scenes(body: Resource):
    ctx = await inputs(body, [scope.ref(body.kind, body.id)])
    if not ctx.get('video_id') or body.kind not in ('srt', 'asset'):
        raise HTTPException(422, 'Choose an SRT assigned to the active project.')
    from agent.api import storyboard
    from agent.api.srt import service as srt
    from agent.api.assembly import service as assembly
    try:
        path = srt.result_path(body.id, require_approved=True) if body.kind == 'srt' else assembly.path(assembly.asset(body.id, 'srt'))
        text = path.read_text(encoding='utf-8-sig')
        db = await get_db()
        doc = await (await db.execute('SELECT id FROM script_document WHERE video_id=?', (ctx['video_id'],))).fetchone()
        if not doc:
            await storyboard.save_document(ctx['video_id'], storyboard.DocumentBody(script_text='', visual_style=''))
        return await storyboard.import_segments(ctx['video_id'], storyboard.ImportBody(format='srt', content=text, source_kind=body.kind, source_id=body.id))
    except (ValueError, OSError) as e:
        raise HTTPException(409, str(e)) from e
