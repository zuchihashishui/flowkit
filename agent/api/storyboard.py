"""Script/audio -> timed segments -> versioned concepts -> existing media queue."""
import asyncio
import json
import math
import logging
import re
import shutil
import time
import uuid
import subprocess
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, ConfigDict, model_validator, field_validator, ValidationError
from agent.db.schema import get_db, _db_lock
from agent.config import OUTPUT_DIR
from agent.services.concept_writer import Concept, write_concept, write_concept_batch

router = APIRouter(prefix='/storyboard', tags=['storyboard'])
AUDIO_DIR = OUTPUT_DIR / 'script_audio'
_concept_tasks = {}


def uid():
    return str(uuid.uuid4())


async def query(sql, args=()):
    db = await get_db()
    cur = await db.execute(sql, args)
    return [dict(r) for r in await cur.fetchall()]


async def one(sql, args=()):
    rows = await query(sql, args)
    if not rows:
        raise HTTPException(404, 'Record not found')
    return rows[0]


@asynccontextmanager
async def transaction():
    async with _db_lock:
        db = await get_db()
        try:
            yield db
            await db.commit()
        except BaseException:
            await db.rollback()
            raise


class DocumentBody(BaseModel):
    script_text: str = Field(default='', max_length=200000)
    visual_style: str = Field(default='', max_length=3000)
    prompt_template: str | None = Field(default=None, max_length=100000)
    prompt_name: str = Field(default='', max_length=255)


class SegmentBody(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    start_ms: int = Field(ge=0, le=86400000)
    end_ms: int = Field(gt=0, le=86400000)
    text: str = Field(min_length=1, max_length=5000)
    @model_validator(mode='after')
    def duration(self):
        if self.end_ms <= self.start_ms:
            raise ValueError('End time must be greater than start time')
        return self


class ImportBody(BaseModel):
    source_kind: Literal['srt', 'asset'] | None = None
    source_id: str | None = None
    format: Literal['srt', 'json']
    content: str = Field(min_length=1, max_length=2000000)

    @model_validator(mode='after')
    def paired_source(self):
        if bool(self.source_kind) != bool(self.source_id):
            raise ValueError('Provide both source kind and source ID.')
        return self


def parse_segments(body):
    if body.format == 'json':
        data = json.loads(body.content.lstrip('\ufeff'))
        if isinstance(data, dict):
            data = data.get('segments')
        if not isinstance(data, list):
            raise ValueError('JSON must be a segment array or an object containing segments')
        items = []
        for row in data:
            def ms(key):
                if key + '_ms' in row:
                    return row[key + '_ms']
                seconds = float(row[key])
                if not math.isfinite(seconds):
                    raise ValueError('Invalid timestamp')
                return round(seconds * 1000)
            items.append(SegmentBody(start_ms=ms('start'), end_ms=ms('end'), text=row['text']))
    else:
        items = []
        text = body.content.lstrip('\ufeff').replace('\r\n', '\n').replace('\r', '\n').strip()
        stamp = r'(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})'
        def to_ms(parts):
            h, m, s, milli = map(int, parts)
            if m >= 60 or s >= 60:
                raise ValueError('Invalid SRT timestamp')
            return ((h * 60 + m) * 60 + s) * 1000 + milli
        for block in re.split(r'\n\s*\n', text):
            lines = block.splitlines()
            if lines and lines[0].strip().isdigit():
                lines.pop(0)
            match = re.fullmatch(stamp + r'\s*-->\s*' + stamp + r'\s*', lines[0] if lines else '')
            if not match:
                raise ValueError('Each SRT cue needs a valid start --> end timestamp')
            items.append(SegmentBody(start_ms=to_ms(match.groups()[:4]), end_ms=to_ms(match.groups()[4:]), text='\n'.join(lines[1:])))
    if not 1 <= len(items) <= 1000:
        raise ValueError('Import 1–1000 segments')
    previous_end = 0
    for item in items:
        if item.start_ms < previous_end:
            raise ValueError('Segments must be chronological without overlapping timestamps')
        previous_end = item.end_ms
    return items


@router.get('/providers')
async def providers():
    from agent.services.chatgpt_gateway import status
    info = await status()
    return {'providers': [{'id': name, 'installed': bool(shutil.which(name))} for name in ('codex', 'claude', 'agy')] + [{'id':'chatgpt-web','installed':info.get('available') and info.get('extensionConnected'),'status':'needs review' if info.get('needsReview') else 'connected (use Test Connection)' if info.get('extensionConnected') else 'disconnected'}]}


@router.put('/videos/{video_id}')
async def save_document(video_id: str, body: DocumentBody):
    await one('SELECT id FROM video WHERE id=?', (video_id,))
    async with transaction() as db:
        doc = await query('SELECT * FROM script_document WHERE video_id=?', (video_id,))
        if doc:
            d = doc[0]
            changed = body.script_text != d['script_text'] or body.visual_style != d['visual_style']
            current = await query('SELECT prompt_template FROM text_prompt_input WHERE document_id=?', (d['id'],))
            changed |= body.prompt_template is not None and body.prompt_template != (current[0]['prompt_template'] if current else '')
            await db.execute('UPDATE script_document SET script_text=?,visual_style=?,revision=revision+?,updated=? WHERE id=?', (body.script_text, body.visual_style, int(changed), time.time(), d['id']))
        else:
            d = {'id': uid()}
            await db.execute('INSERT INTO script_document(id,video_id,script_text,visual_style,created,updated) VALUES(?,?,?,?,?,?)', (d['id'], video_id, body.script_text, body.visual_style, time.time(), time.time()))
        if body.prompt_template is not None:
            await db.execute('INSERT INTO text_prompt_input(document_id,prompt_template,prompt_name) VALUES(?,?,?) ON CONFLICT(document_id) DO UPDATE SET prompt_template=excluded.prompt_template,prompt_name=excluded.prompt_name', (d['id'], body.prompt_template, body.prompt_name))
    return await read_document(video_id)


@router.get('/videos/{video_id}/saved-srt')
async def saved_srt(video_id: str):
    """Offer an existing source without replacing saved scenes."""
    from agent.services import workflow_scope as scope
    from agent.api.srt import service as srt
    from agent.api.assembly import service as assembly
    video = await one('SELECT id,project_id FROM video WHERE id=?', (video_id,))
    ctx = {'project_id': video['project_id'], 'video_id': video_id}
    for item in scope.select(scope.catalog(), **ctx):
        kind = item['resource_kind']
        if not (kind == 'srt' and item['state'] == 'COMPLETED' or kind == 'asset' and item['asset_type'] == 'srt'):
            continue
        try:
            path = srt.result_path(item['id'], require_approved=True) if kind == 'srt' else assembly.path(assembly.asset(item['id'], 'srt'))
            if path.stat().st_size > 2000000:
                continue
            text = path.read_text(encoding='utf-8-sig')
            parse_segments(ImportBody(format='srt', content=text))
            return {'name': (item['title'] or 'scenes')[:251] + ('' if (item['title'] or '').lower().endswith('.srt') else '.srt'),
                    'text': text, 'source_kind': kind, 'source_id': item['id']}
        except (ValueError, OSError, UnicodeError):
            continue
    return None


class PromptInputBody(BaseModel):
    source_kind: Literal['srt', 'asset'] | None = None
    source_id: str | None = None
    srt_content: str = Field(min_length=1, max_length=2000000)
    srt_name: str = Field(min_length=1, max_length=255)
    prompt_template: str = Field(min_length=1, max_length=100000)
    prompt_name: str = Field(default='', max_length=255)


@router.post('/videos/{video_id}/prompt-input')
async def import_prompt_input(video_id: str, body: PromptInputBody):
    """Import the two inputs atomically, preserving one row per SRT cue."""
    await one('SELECT id FROM video WHERE id=?', (video_id,))
    if body.source_kind or body.source_id:
        from agent.services import workflow_scope as scope
        from agent.api.srt import service as srt
        from agent.api.assembly import service as assembly
        video = await one('SELECT project_id FROM video WHERE id=?', (video_id,))
        try:
            if not body.source_kind or not body.source_id:
                raise ValueError('Incomplete SRT source.')
            scope.resolve({'project_id': video['project_id'], 'video_id': video_id}, [scope.ref(body.source_kind, body.source_id)])
            source_path = srt.result_path(body.source_id, require_approved=True) if body.source_kind == 'srt' else assembly.path(assembly.asset(body.source_id, 'srt'))
            if source_path.read_text(encoding='utf-8-sig') != body.srt_content:
                raise ValueError('The saved SRT changed. Reopen SRT to Prompt to reload it.')
        except (ValueError, OSError) as exc:
            raise HTTPException(409, str(exc)) from exc
    if not body.prompt_template.strip():
        raise HTTPException(400, 'The prompt TXT is empty.')
    try:
        items = parse_segments(ImportBody(format='srt', content=body.srt_content))
    except ValueError as exc:
        raise HTTPException(400, f'Invalid SRT: {exc}') from exc
    async with transaction() as db:
        docs = await query('SELECT * FROM script_document WHERE video_id=?', (video_id,))
        if docs:
            doc = docs[0]
            if await query('SELECT id FROM script_segment WHERE document_id=? LIMIT 1', (doc['id'],)):
                raise HTTPException(409, 'This video already has SRT rows. Save the prompt TXT for these rows, or select a new video to import another SRT.')
            await db.execute('UPDATE script_document SET revision=revision+1,updated=? WHERE id=?', (time.time(), doc['id']))
        else:
            doc = {'id': uid()}
            await db.execute('INSERT INTO script_document(id,video_id,created,updated) VALUES(?,?,?,?)', (doc['id'], video_id, time.time(), time.time()))
        await db.executemany('INSERT INTO script_segment(id,document_id,ordinal,start_ms,end_ms,text) VALUES(?,?,?,?,?,?)', [(uid(), doc['id'], i+1, s.start_ms, s.end_ms, s.text) for i, s in enumerate(items)])
        await db.execute('INSERT INTO document_source VALUES(?,?,?,?,?)', (doc['id'], body.source_kind or 'external', body.source_id, body.srt_content, time.time()))
        await db.execute('INSERT INTO text_prompt_input VALUES(?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET prompt_template=excluded.prompt_template,prompt_name=excluded.prompt_name,srt_name=excluded.srt_name', (doc['id'], body.prompt_template, body.prompt_name, body.srt_name))
    return await read_document(video_id)


def media_is_current(video, document, segment, payload):
    """Adding the other prompt must not invalidate media whose own prompt is unchanged."""
    kind=payload.get('kind')
    if kind not in {'image','video'} or not segment.get('ready'):
        return False
    original=next((c for c in segment['concepts'] if c['id']==payload.get('concept_id')),None)
    active=segment['active_concept']
    return bool(original and original['segment_revision']==segment['revision']
        and original['document_revision']==document['revision']
        and payload.get('project_id')==video['project_id']
        and payload.get('video_id')==video['id']
        and payload.get('document_id')==document['id']
        and payload.get('segment_id')==segment['id']
        and payload.get('start_ms')==segment['start_ms'] and payload.get('end_ms')==segment['end_ms']
        and active[kind+'_prompt'].strip()
        and original[kind+'_prompt']==active[kind+'_prompt']==payload.get('prompt'))


@router.get('/videos/{video_id}')
async def read_document(video_id: str):
    video = await one('SELECT id,project_id,title FROM video WHERE id=?', (video_id,))
    docs = await query('SELECT * FROM script_document WHERE video_id=?', (video_id,))
    options, instruction_files = await resolved_prompt_options(docs[0]['id'] if docs else None, video)
    if not docs:
        return {'video': video, 'document': None, 'segments': [], 'warnings': [],
                'prompt_options': options.model_dump(), 'prompt_instruction_files': instruction_files}
    doc = docs[0]
    inputs = await query('SELECT prompt_template,prompt_name,srt_name FROM text_prompt_input WHERE document_id=?', (doc['id'],))
    doc.update(inputs[0] if inputs else {'prompt_template':'', 'prompt_name':'', 'srt_name':''})
    doc['prompt_options'] = options.model_dump()
    doc['prompt_instruction_files'] = instruction_files
    provenance = await query('SELECT kind,source_id,imported FROM document_source WHERE document_id=?', (doc['id'],))
    doc['source'] = provenance[0] if provenance else None
    segments = await query('SELECT * FROM script_segment WHERE document_id=? ORDER BY ordinal', (doc['id'],))
    concepts = await query('SELECT c.* FROM scene_concept c JOIN script_segment s ON s.id=c.segment_id WHERE s.document_id=? ORDER BY c.version DESC', (doc['id'],))
    jobs = await query('SELECT j.id,j.segment_id,j.state,j.error,j.created,j.payload FROM concept_job j JOIN script_segment s ON s.id=j.segment_id WHERE s.document_id=? ORDER BY j.created DESC', (doc['id'],))
    # Parsing large saved instruction snapshots and querying the synchronous
    # media store must not block /health, WebSocket replies or queue dispatch.
    return await asyncio.to_thread(_document_snapshot, video, doc, segments, concepts, jobs)


def _document_snapshot(video, doc, segments, concepts, jobs):
    from collections import defaultdict
    from agent.services.prompt_batch import session_folder
    prompt_outputs = {}
    for job in jobs:
        payload = json.loads(job.pop('payload'))
        job['prompt_kind'] = payload.get('prompt_kind', 'both')
        job['text_batch_id'] = payload.get('text_batch_id')
        job['instruction_type'] = payload.get('instruction_type')
        session = payload.get('text_output_id') or payload.get('text_session_id')
        if job['text_batch_id'] and session and session not in prompt_outputs:
            try:
                folder = session_folder(session, payload)
            except ValueError:
                continue
            prompt_outputs[session] = {'kind': 'mixed' if payload.get('use_row_instructions') else job['prompt_kind'], 'directory': str(folder)} if folder.is_dir() else None
    from agent.api.desktop import rows
    media_by_segment = defaultdict(list)
    for job in rows(video['project_id'], video['id']):
        payload = json.loads(job['payload'])
        if payload.get('segment_id'):
            media_by_segment[payload['segment_id']].append((job, payload))
    concepts_by_segment, jobs_by_segment = defaultdict(list), defaultdict(list)
    for concept in concepts:
        concepts_by_segment[concept['segment_id']].append(concept)
    for job in jobs:
        jobs_by_segment[job['segment_id']].append(job)
    warnings = []
    previous_end = 0
    for s in segments:
        s['concepts'] = concepts_by_segment[s['id']]
        active = next((c for c in s['concepts'] if c['id'] == s['active_concept_id']), None)
        s['active_concept'] = active
        s['ready'] = bool(active and active['segment_revision'] == s['revision'] and active['document_revision'] == doc['revision'])
        s['image_ready']=bool(s['ready'] and active['image_prompt'].strip())
        s['video_ready']=bool(s['ready'] and active['video_prompt'].strip())
        scene_jobs = jobs_by_segment[s['id']]
        s['job'] = scene_jobs[0] if scene_jobs else None
        s['prompt_jobs'] = {kind: next((j for j in scene_jobs if j['prompt_kind'] in {kind,'both'}), None) for kind in ('image','video')}
        s['media_jobs'] = []
        for j, payload in media_by_segment[s['id']]:
            s['media_jobs'].append({'id': j['id'], 'state': j['state'], 'kind': payload['kind'], 'concept_id': payload.get('concept_id'), 'current': media_is_current(video, doc, s, payload), 'files': json.loads(j['files']), 'error': j['error'], 'can_resume': bool(j['remote'])})
        if s['start_ms'] > previous_end:
            warnings.append(f"Gap before segment {s['ordinal']}: {s['start_ms'] - previous_end} ms. Timestamps are preserved.")
        previous_end = s['end_ms']
        if doc['audio_duration_ms'] and s['end_ms'] > doc['audio_duration_ms'] + 100:
            warnings.append(f"Segment {s['ordinal']} extends beyond the audio duration.")
    if doc['audio_duration_ms'] and previous_end < doc['audio_duration_ms']:
        warnings.append(f"Audio continues {doc['audio_duration_ms'] - previous_end} ms after the last segment.")
    from agent.services.scene_images import image_folder
    return {'video': video, 'document': doc, 'segments': segments, 'warnings': warnings,
            'image_output_directory': str(image_folder(video['id'])),
            'prompt_outputs': [item for item in prompt_outputs.values() if item]}


@router.post('/videos/{video_id}/collect-images')
async def collect_saved_images(video_id: str):
    from agent.services.scene_images import collect_images
    try:
        return await collect_images(video_id)
    except OSError as exc:
        raise HTTPException(409, f'Could not copy saved images. Check folder permissions and free space: {exc}') from exc


@router.post('/videos/{video_id}/segments')
async def import_segments(video_id: str, body: ImportBody):
    if body.source_kind or body.source_id:
        from agent.api.workflow import context
        from agent.services import workflow_scope as scope
        video = await one('SELECT * FROM video WHERE id=?', (video_id,))
        try:
            scope.resolve(await context(video['project_id'], video_id), [scope.ref(body.source_kind, body.source_id)])
            from agent.api.srt import service as srt
            from agent.api.assembly import service as assembly
            path = srt.result_path(body.source_id) if body.source_kind == 'srt' else assembly.path(assembly.asset(body.source_id, 'srt'))
            original = path.read_text(encoding='utf-8-sig')
            if body.format != 'srt' or body.content.lstrip('\ufeff').replace('\r\n', '\n') != original.replace('\r\n', '\n'):
                raise ValueError('Scene content does not match the selected SRT version.')
        except (ValueError, OSError) as exc:
            raise HTTPException(409, str(exc)) from exc
    try:
        items = parse_segments(body)
    except (ValueError, KeyError, TypeError, IndexError) as exc:
        raise HTTPException(400, f'Invalid segments: {exc}') from exc
    async with transaction() as db:
        doc = await one('SELECT * FROM script_document WHERE video_id=?', (video_id,))
        if await query('SELECT id FROM script_segment WHERE document_id=? LIMIT 1', (doc['id'],)):
            raise HTTPException(409, 'This collection already has segments. Edit them in place or create a new collection for another import.')
        await db.executemany('INSERT INTO script_segment(id,document_id,ordinal,start_ms,end_ms,text) VALUES(?,?,?,?,?,?)', [(uid(), doc['id'], i+1, s.start_ms, s.end_ms, s.text) for i, s in enumerate(items)])
        await db.execute('INSERT INTO document_source VALUES(?,?,?,?,?)', (doc['id'], body.source_kind or 'external', body.source_id, body.content, time.time()))
    return await read_document(video_id)


@router.patch('/segments/{segment_id}')
async def edit_segment(segment_id: str, body: SegmentBody):
    async with transaction() as db:
        s = await one('SELECT * FROM script_segment WHERE id=?', (segment_id,))
        before = await query('SELECT end_ms FROM script_segment WHERE document_id=? AND ordinal<? ORDER BY ordinal DESC LIMIT 1', (s['document_id'], s['ordinal']))
        after = await query('SELECT start_ms FROM script_segment WHERE document_id=? AND ordinal>? ORDER BY ordinal LIMIT 1', (s['document_id'], s['ordinal']))
        if (before and body.start_ms < before[0]['end_ms']) or (after and body.end_ms > after[0]['start_ms']):
            raise HTTPException(409, 'The new timestamps overlap a neighboring segment.')
        changed = any(s[k] != getattr(body, k) for k in ('start_ms','end_ms','text'))
        await db.execute('UPDATE script_segment SET start_ms=?,end_ms=?,text=?,revision=revision+? WHERE id=?', (body.start_ms, body.end_ms, body.text, int(changed), segment_id))
    return {'ok': True}


async def store_concept(db, segment, doc, concept, provider, source_text, sr, dr, activate=True):
    version = (await query('SELECT COALESCE(MAX(version),0)+1 AS version FROM scene_concept WHERE segment_id=?', (segment['id'],)))[0]['version']
    cid = uid()
    await db.execute('INSERT INTO scene_concept(id,segment_id,version,segment_revision,document_revision,title,description,image_prompt,video_prompt,provider,source_text,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', (cid, segment['id'], version, sr, dr, concept.title, concept.description, concept.image_prompt, concept.video_prompt, provider, source_text, time.time()))
    if activate:
        await db.execute('UPDATE script_segment SET active_concept_id=? WHERE id=?', (cid, segment['id']))
    return cid


@router.post('/segments/{segment_id}/concepts')
async def save_concept(segment_id: str, body: Concept):
    async with transaction() as db:
        s = await one('SELECT * FROM script_segment WHERE id=?', (segment_id,))
        doc = await one('SELECT * FROM script_document WHERE id=?', (s['document_id'],))
        cid = await store_concept(db, s, doc, body, 'manual', s['text'], s['revision'], doc['revision'])
    return {'id': cid}


@router.post('/concepts/{concept_id}/select')
async def select_concept(concept_id: str):
    async with transaction() as db:
        c = await one('SELECT * FROM scene_concept WHERE id=?', (concept_id,))
        s = await one('SELECT * FROM script_segment WHERE id=?', (c['segment_id'],))
        doc = await one('SELECT * FROM script_document WHERE id=?', (s['document_id'],))
        if c['segment_revision'] != s['revision'] or c['document_revision'] != doc['revision']:
            raise HTTPException(409, 'This version belongs to an older script/segment. Review it and save a new version first.')
        await db.execute('UPDATE script_segment SET active_concept_id=? WHERE id=?', (concept_id, s['id']))
    return {'ok': True}


InstructionType = Literal['image', 'video_4s', 'video_6s', 'video_8s', 'video_10s']


class InstructionFile(BaseModel):
    text: str = Field(default='', max_length=97000)
    name: str = Field(default='', max_length=255)
    source: Literal['manual', 'folder', 'project'] = 'manual'


class PromptOptions(BaseModel):
    chatgpt_model: str = Field(default='GPT-5.6 Sol', min_length=1, max_length=100, pattern=r'^[^-\s][^\r\n]*$')
    composer_mode: Literal['work', 'chat'] = 'chat'

    @field_validator('composer_mode')
    @classmethod
    def chat_only(cls, value):
        return 'chat'

    batch_size: int = Field(default=10, ge=1, le=20)
    video_row_count: int = Field(default=15, ge=0, le=1000)
    templates: dict[InstructionType, InstructionFile] = Field(default_factory=dict)
    row_instructions: dict[str, Literal['image','video','video_4s','video_6s','video_8s','video_10s']] = Field(default_factory=dict, max_length=1000)


async def prompt_options(document_id):
    options, _ = await resolved_prompt_options(document_id)
    return options


async def resolved_prompt_options(document_id, video=None):
    from agent.services.prompt_instructions import discover
    rows = await query('SELECT settings FROM text_prompt_options WHERE document_id=?', (document_id,)) if document_id else []
    options = PromptOptions.model_validate_json(rows[0]['settings']) if rows else PromptOptions()
    if document_id and 'image' not in options.templates:
        legacy = await query('SELECT prompt_template,prompt_name FROM text_prompt_input WHERE document_id=?', (document_id,))
        if legacy and legacy[0]['prompt_template'].strip():
            options.templates['image'] = InstructionFile(text=legacy[0]['prompt_template'], name=legacy[0]['prompt_name'])
    if video is None:
        video = await one('SELECT v.id,v.project_id FROM video v JOIN script_document d ON d.video_id=v.id WHERE d.id=?', (document_id,))
    from agent.services.project_settings import get as project_settings
    shared = (await project_settings(video['project_id']))['instruction_files']
    if shared['configured']:
        options.templates = {key: InstructionFile(**{k: value[k] for k in ('name', 'text', 'source')})
                             for key, value in shared['templates'].items() if key in ('image', 'video_4s', 'video_6s', 'video_8s', 'video_10s')}
        return options, {key: shared[key] for key in ('directory', 'warnings', 'configured')}
    files = await asyncio.to_thread(discover, {'video_id': video['id'], 'project_id': video['project_id']}, options.templates)
    # Never use a stale snapshot after an auto-loaded file is removed or invalid.
    options.templates = {key: (InstructionFile(name=value.name, source='folder') if value.source == 'folder' else value)
                         for key, value in options.templates.items()}
    for key, value in files.pop('templates').items():
        options.templates[key] = InstructionFile(**value)
    return options, files


@router.put('/videos/{video_id}/prompt-options')
async def save_prompt_options(video_id: str, body: PromptOptions):
    async with transaction() as db:
        doc = await one('SELECT id FROM script_document WHERE video_id=?', (video_id,))
        ids = {r['id'] for r in await query('SELECT id FROM script_segment WHERE document_id=?', (doc['id'],))}
        if not set(body.row_instructions).issubset(ids):
            raise HTTPException(400, 'Instruction choices must belong to this video.')
        await db.execute('INSERT INTO text_prompt_options VALUES(?,?) ON CONFLICT(document_id) DO UPDATE SET settings=excluded.settings', (doc['id'], body.model_dump_json()))
    return body.model_dump()


class GenerateBody(BaseModel):
    fresh_start: bool = False
    segment_ids: list[str] = Field(min_length=1, max_length=1000)
    provider: Literal['codex','claude','agy','chatgpt-web'] = 'codex'
    model: str | None = Field(default=None, max_length=100, pattern=r'^[^-\s][^\r\n]*$')
    regenerate: bool = False
    prompt_kind: Literal['both','image','video'] = 'both'
    use_row_instructions: bool = False
    batch_size: int = Field(default=10, ge=1, le=20)
    composer_mode: Literal['work','chat'] = 'chat'

    @field_validator('composer_mode')
    @classmethod
    def chat_only(cls, value):
        return 'chat'



@router.post('/videos/{video_id}/generate-concepts')
async def generate_concepts(video_id: str, body: GenerateBody):
    if body.provider == 'chatgpt-web':
        from agent.services.chatgpt_gateway import status
        info = await status()
        if not info.get('available') or not info.get('extensionConnected') or info.get('enabled') is False:
            raise HTTPException(503, 'Connect ChatGPT Web and turn on the extension first.')
        if body.composer_mode=='chat' and 'chat-prompt-zip-v1' not in info.get('capabilities',[]):
            raise HTTPException(503, 'Reload ChatGPT Bridge 1.13.0 and restart the gateway to use the Chat tab for ZIP batches.')
        if info.get('needsReview'):
            raise HTTPException(503, 'ChatGPT reported an account rate limit. Wait and resume after the limit clears.')
    elif not shutil.which(body.provider):
        raise HTTPException(503, f'{body.provider} CLI is not installed or not on PATH. Install and sign in to it before creating concepts.')
    project_settings = None
    if body.provider=='chatgpt-web' and (body.use_row_instructions or body.prompt_kind in {'image','video'}):
        from agent.services.chatgpt_gateway import ensure_project_workers, open_text_tab
        from agent.services.project_settings import get
        video=await one('SELECT project_id FROM video WHERE id=?',(video_id,))
        project_settings=await get(video['project_id'])
        try:
            if body.fresh_start:
                await open_text_tab()
            else:
                await ensure_project_workers()
        except ValueError as error:
            raise HTTPException(503,str(error)) from error
    ids, skipped, batches = [], [], []
    session_id = uid()
    group_sessions, group_counts, group_batches = {}, {}, {}
    async with transaction() as db:
        doc = await one('SELECT * FROM script_document WHERE video_id=?', (video_id,))
        segments = await query('SELECT * FROM script_segment WHERE document_id=? ORDER BY ordinal', (doc['id'],))
        mapping = {s['id']: (i,s) for i,s in enumerate(segments)}
        inputs = await query('SELECT prompt_template FROM text_prompt_input WHERE document_id=?', (doc['id'],))
        prompt_template = inputs[0]['prompt_template'] if inputs else ''
        if any(sid not in mapping for sid in body.segment_ids):
            raise HTTPException(400, 'All selected segments must belong to this collection.')
        options = await prompt_options(doc['id'])
        if body.provider=='chatgpt-web' and not body.model:
            body.model=options.chatgpt_model
        choices = {sid: ('image' if options.row_instructions.get(sid,'video' if row['ordinal']<=options.video_row_count else 'image')=='image' else 'video_'+str(next((n for n in (4,6,8,10) if row['end_ms']-row['start_ms']<=n*1000),10))+'s') for sid,(_,row) in mapping.items()} if body.use_row_instructions else {}
        if body.provider == 'chatgpt-web':
            from agent.services.project_instructions import supports_zip
            needs_zip = any(v == 'image' for v in choices.values()) if body.use_row_instructions else body.prompt_kind == 'image'
            if needs_zip and not supports_zip(body.model):
                raise HTTPException(400, 'Image ZIP output currently supports GPT-5.6 Sol. Other model output adapters are not configured yet.')
        if body.use_row_instructions:
            for sid in set(body.segment_ids):
                instruction = choices.get(sid, 'image')
                template = options.templates.get(instruction, InstructionFile(text=prompt_template if instruction=='image' else ''))
                if not template.text.strip():
                    raise HTTPException(400, f'Scene {mapping[sid][1]["ordinal"]:03d}: save template_{instruction}_prompt.txt in Project settings first.')
        if options.templates.get('image'):
            prompt_template = options.templates['image'].text
        video_zip_batches = body.provider == 'chatgpt-web' and supports_zip(body.model)
        group_order = {'video_4s': 0, 'video_6s': 1, 'video_8s': 2, 'video_10s': 3, 'image': 4}
        ordered = sorted(set(body.segment_ids), key=lambda sid: ((group_order.get(choices.get(sid, 'image'), 4) if video_zip_batches else (1 if choices.get(sid,'image')=='image' else 0)) if body.use_row_instructions else 0, mapping[sid][0]))
        for sid in ordered:
            instruction = choices.get(sid, 'image') if body.use_row_instructions else body.prompt_kind
            target = ('image' if instruction=='image' else 'video') if body.use_row_instructions else body.prompt_kind
            row_template = options.templates.get(instruction, InstructionFile(text=prompt_template if instruction=='image' else '')).text if body.use_row_instructions else prompt_template
            i,s = mapping[sid]
            active = await query('SELECT * FROM scene_concept WHERE id=?', (s['active_concept_id'],))
            ready = active and active[0]['segment_revision'] == s['revision'] and active[0]['document_revision'] == doc['revision']
            pending = await query("SELECT id FROM concept_job WHERE segment_id=? AND state IN ('QUEUED','RUNNING')", (sid,))
            target_ready=ready and (bool(active[0][target+'_prompt'].strip()) if target!='both' else bool(active[0]['image_prompt'].strip() and active[0]['video_prompt'].strip()))
            if target_ready and body.use_row_instructions:
                prior = await query("SELECT payload FROM concept_job WHERE segment_id=? AND state='COMPLETED' ORDER BY created DESC", (sid,))
                matching = next((json.loads(j['payload']) for j in prior if json.loads(j['payload']).get('prompt_kind')==target), None)
                if matching and (matching.get('instruction_type', target)!=instruction or matching.get('prompt_template')!=row_template):
                    target_ready = False
            if pending or (target_ready and not body.regenerate):
                skipped.append(sid)
                continue
            payload = {'video_id': video_id, **body.model_dump(exclude={'segment_ids','regenerate'}), 'ordinal': s['ordinal'], 'text': s['text'], 'start_ms': s['start_ms'], 'end_ms': s['end_ms'], 'segment_revision': s['revision'], 'document_revision': doc['revision'], 'active_concept_id': s['active_concept_id'], 'visual_style': doc['visual_style'], 'script_context': doc['script_text'][:8000], 'previous_text': segments[i-1]['text'][:1000] if i else '', 'next_text': segments[i+1]['text'][:1000] if i+1<len(segments) else ''}
            payload.update(prompt_kind=target, instruction_type=instruction)
            if project_settings is not None and (target == 'image' or target == 'video' and supports_zip(body.model)):
                from agent.services.project_instructions import DEFAULT_ZIP
                shared = project_settings.get('instruction_files', {})
                zip_text = shared.get('templates', {}).get('zip_file', {}).get('text', DEFAULT_ZIP)
                if not zip_text.strip():
                    raise HTTPException(400, 'Save template_zip_file_prompt.txt in Project settings before starting ZIP prompt jobs.')
                if len(row_template) + len(zip_text.replace('{batch_size}', str(body.batch_size))) + 2 > 100000:
                    raise HTTPException(400, 'Prompt instructions plus ZIP instructions must fit within 100,000 characters.')
                payload['zip_template'] = zip_text
            if project_settings is not None:
                payload['project_settings']=project_settings
                payload['retained_prompt']=active[0]['video_prompt' if target=='image' else 'image_prompt'] if ready else ''
                if row_template.strip():
                    payload['prompt_template'] = row_template
                    payload['text_output_id'] = session_id
                    payload['text_session_id'] = group_sessions.setdefault(instruction if video_zip_batches else ('video' if target=='video' else instruction), uid())
                    if target=='video':
                        payload['video_prompt_text'] = 'zip_template' not in payload
                        payload['video_prompt_zip'] = 'zip_template' in payload
                        payload['batch_size'] = 10 if payload['video_prompt_zip'] else 1
                    elif body.use_row_instructions:
                        payload['image_phase_start'] = group_counts.get('image',0)==0 and any(k.startswith('video') for k in group_counts)
                    count = group_counts.get(instruction, 0)
                    if count % payload['batch_size'] == 0:
                        group_batches[instruction] = uid()
                        batches.append(group_batches[instruction])
                    group_counts[instruction] = count + 1
                    payload['text_batch_id'] = group_batches[instruction]
            jid = uid()
            await db.execute("INSERT INTO concept_job(id,segment_id,state,payload,created) VALUES(?,?,'QUEUED',?,?)", (jid, sid, json.dumps(payload), time.time()))
            ids.append(jid)
    return {'ids': ids, 'skipped': skipped, 'batch_count': len(batches), 'batch_size': body.batch_size if batches else 1}


@router.post('/videos/{video_id}/restart-text')
async def restart_text(video_id: str):
    await one('SELECT id FROM video WHERE id=?', (video_id,))
    from agent.services.chatgpt_gateway import open_text_tab
    try:
        return await open_text_tab()
    except ValueError as error:
        logging.getLogger(__name__).warning('SRT to Prompt Start blocked video=%s: %s', video_id, error)
        raise HTTPException(409, str(error)) from error


@router.post('/videos/{video_id}/cancel-concepts')
async def cancel_concepts(video_id: str):
    async with transaction() as db:
        result = await db.execute("UPDATE concept_job SET state='CANCELLED' WHERE state='QUEUED' AND segment_id IN (SELECT s.id FROM script_segment s JOIN script_document d ON d.id=s.document_id WHERE d.video_id=?)", (video_id,))
    return {'cancelled': result.rowcount}


async def process_concept(job):
    batch = json.loads(job['payload']).get('text_batch_id')
    if batch:
        return await process_concept_batch(batch)
    async with transaction() as db:
        if not (await db.execute("UPDATE concept_job SET state='RUNNING' WHERE id=? AND state='QUEUED'", (job['id'],))).rowcount:
            return
    payload = json.loads(job['payload'])
    try:
        concept = await write_concept(payload)
        async with transaction() as db:
            s = await one('SELECT * FROM script_segment WHERE id=?', (job['segment_id'],))
            doc = await one('SELECT * FROM script_document WHERE id=?', (s['document_id'],))
            fresh = s['revision'] == payload['segment_revision'] and doc['revision'] == payload['document_revision'] and s['active_concept_id'] == payload['active_concept_id']
            cid = await store_concept(db, s, doc, concept, payload['provider'], payload['text'], payload['segment_revision'], payload['document_revision'], fresh)
            await db.execute('UPDATE concept_job SET state=?,concept_id=?,error=? WHERE id=?', ('COMPLETED' if fresh else 'STALE', cid, None if fresh else 'Source or selected concept changed while AI was running. Result kept in history.', job['id']))
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        from agent.services.chatgpt_gateway import GatewayReviewRequired, GatewayBusy
        if isinstance(exc, GatewayBusy):
            async with transaction() as db:
                await db.execute("UPDATE concept_job SET state='QUEUED' WHERE id=?", (job['id'],))
            return
        state = 'NEEDS_REVIEW' if isinstance(exc, GatewayReviewRequired) else 'FAILED'
        async with transaction() as db:
            await db.execute("UPDATE concept_job SET state=?,error=? WHERE id=?", (state, str(exc)[:1500], job['id']))


async def process_concept_batch(batch_id):
    # Claim the complete queued group atomically. Each row keeps its own job,
    # revision snapshot, history and status; only the remote request is shared.
    async with transaction() as db:
        jobs = await query("SELECT * FROM concept_job WHERE state='QUEUED' AND json_extract(payload,'$.text_batch_id')=? ORDER BY created", (batch_id,))
        if not jobs:
            return
        for job in jobs:
            await db.execute("UPDATE concept_job SET state='RUNNING' WHERE id=?", (job['id'],))
    payloads = [json.loads(job['payload']) for job in jobs]
    async def save_batch(concepts):
        if set(concepts) != {p['ordinal'] for p in payloads}:
            raise ValueError('The batch did not return every requested row. No prompts were assigned.')
        async with transaction() as db:
            for job, payload in zip(jobs, payloads):
                segment = await one('SELECT * FROM script_segment WHERE id=?', (job['segment_id'],))
                doc = await one('SELECT * FROM script_document WHERE id=?', (segment['document_id'],))
                fresh = segment['revision'] == payload['segment_revision'] and doc['revision'] == payload['document_revision'] and segment['active_concept_id'] == payload['active_concept_id']
                cid = await store_concept(db, segment, doc, concepts[payload['ordinal']], payload['provider'], payload['text'], payload['segment_revision'], payload['document_revision'], fresh)
                await db.execute('UPDATE concept_job SET state=?,concept_id=?,error=? WHERE id=?', ('COMPLETED' if fresh else 'STALE', cid, None if fresh else 'Source or selected concept changed while AI was running. Result kept in history.', job['id']))
    try:
        await write_concept_batch(payloads, save_result=save_batch)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        from agent.services.chatgpt_gateway import GatewayReviewRequired, GatewayBusy
        state = 'QUEUED' if isinstance(exc, GatewayBusy) else 'NEEDS_REVIEW' if isinstance(exc, GatewayReviewRequired) else 'FAILED'
        error = None if state == 'QUEUED' else ('Rows ' + ', '.join(f"{p['ordinal']:03d}" for p in payloads) + ': ' + str(exc))[:1500]
        async with transaction() as db:
            for job in jobs:
                await db.execute('UPDATE concept_job SET state=?,error=? WHERE id=?', (state, error, job['id']))


async def run():
    async with transaction() as db:
        await db.execute("UPDATE concept_job SET state='NEEDS_REVIEW',error='App stopped during AI generation. Check before submitting again.' WHERE state='RUNNING'")
        await db.execute("UPDATE concept_job SET state='NEEDS_REVIEW',error='Queued by an older version. Retry selected rows to use one Work tab and ZIP batches.' WHERE state='QUEUED' AND json_extract(payload,'$.provider')='chatgpt-web' AND json_extract(payload,'$.text_session_id') IS NOT NULL AND json_extract(payload,'$.text_batch_id') IS NULL")
    tasks = _concept_tasks
    try:
        while True:
            for jid, task in list(tasks.items()):
                if task.done():
                    if not task.cancelled():
                        task.result()
                    del tasks[jid]
            from agent.services.chatgpt_gateway import status
            info = await status()
            slots = info.get('availableSlots',0)
            pending = await query("SELECT * FROM concept_job WHERE state='QUEUED' ORDER BY created LIMIT 200")
            for job in pending:
                if tasks:
                    break
                payload = json.loads(job['payload'])
                if payload.get('prompt_kind')=='image' and payload.get('text_output_id'):
                    waiting = await query("SELECT 1 FROM concept_job WHERE json_extract(payload,'$.text_output_id')=? AND json_extract(payload,'$.prompt_kind')='video' AND state NOT IN ('COMPLETED','STALE') LIMIT 1", (payload['text_output_id'],))
                    if waiting:
                        continue
                task_id = payload.get('text_batch_id') or job['id']
                if task_id in tasks:
                    continue
                if payload.get('provider') == 'chatgpt-web':
                    if slots <= 0:
                        continue
                    slots -= 1
                elif tasks:
                    continue
                from agent.services import chatgpt_gateway
                if payload.get('provider') == 'chatgpt-web' and chatgpt_gateway._restarting_text:
                    continue
                tasks[task_id] = asyncio.create_task(process_concept(job))
                tasks[task_id].text_provider = payload.get('provider') == 'chatgpt-web'
            await asyncio.sleep(1)
    finally:
        for task in tasks.values():
            task.cancel()
        await asyncio.gather(*tasks.values(),return_exceptions=True)
        tasks.clear()


@router.post('/videos/{video_id}/audio')
async def upload_audio(video_id: str, audio: UploadFile = File(...)):
    doc = await one('SELECT * FROM script_document WHERE video_id=?', (video_id,))
    suffix = Path(audio.filename or '').suffix.lower()
    if suffix not in ('.mp3','.wav','.m4a','.flac','.ogg','.aac','.mp4'):
        raise HTTPException(400, 'Choose an MP3, WAV, M4A, FLAC, OGG, AAC or MP4 audio file.')
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    from agent.services.output_paths import owned_path
    dest = owned_path(AUDIO_DIR / (uid() + suffix), {'video_id': video_id}, 'audio/' + uid() + suffix)
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        size = 0
        with dest.open('wb') as out:
            while chunk := await audio.read(262144):
                size += len(chunk)
                if size > 512*1024*1024:
                    raise HTTPException(413, 'Audio must be under 512 MiB')
                out.write(chunk)
        def probe():
            r = subprocess.run(['ffprobe','-v','error','-show_format','-show_streams','-of','json',str(dest)],capture_output=True,text=True,timeout=30)
            data = json.loads(r.stdout or '{}')
            duration = float(data.get('format',{}).get('duration',0))
            if r.returncode or not math.isfinite(duration) or duration <= 0 or not any(s['codec_type']=='audio' for s in data.get('streams',[])):
                raise ValueError('The file needs an audio stream and a valid duration')
            return round(duration*1000)
        duration = await asyncio.to_thread(probe)
        async with transaction() as db:
            await db.execute('UPDATE script_document SET audio_path=?,audio_name=?,audio_duration_ms=?,updated=? WHERE id=?', (str(dest),Path(audio.filename).name,duration,time.time(),doc['id']))
        return {'name': Path(audio.filename).name,'duration_ms':duration}
    except BaseException as exc:
        dest.unlink(missing_ok=True)
        if isinstance(exc, Exception) and not isinstance(exc, HTTPException):
            raise HTTPException(400, 'Cannot import audio. Check the file and FFprobe installation.') from exc
        raise


@router.get('/videos/{video_id}/audio')
async def get_audio(video_id: str):
    doc = await one('SELECT * FROM script_document WHERE video_id=?', (video_id,))
    path = Path(doc['audio_path'] or '').resolve()
    from agent.services.output_paths import allowed
    if not allowed(path, AUDIO_DIR) or not path.is_file():
        raise HTTPException(404, 'Audio is not available')
    return FileResponse(path)


class MediaBody(BaseModel):
    segment_ids: list[str] = Field(min_length=1, max_length=200)
    kind: Literal['image','video']
    orientation: Literal['HORIZONTAL','VERTICAL'] = 'HORIZONTAL'
    duration: Literal[4,6,8,10] = 8
    duration_mode: Literal['manual','srt'] = 'manual'
    image_model: str | None = None
    regenerate: bool = False


@router.post('/videos/{video_id}/generate-media')
async def generate_media(video_id: str, body: MediaBody):
    from agent.services.production_settings import apply_stage
    video=await one('SELECT project_id FROM video WHERE id=?',(video_id,))
    body=await apply_stage(body,'media',{'project_id':video['project_id'],'video_id':video_id})
    # Freeze the selected source revisions until their immutable jobs are saved.
    async with _db_lock:
        from agent.api import desktop
        data = await read_document(video_id)
        mapping = {s['id']:s for s in data['segments']}
        selected = list(dict.fromkeys(body.segment_ids))
        if any(sid not in mapping or not mapping[sid]['ready'] or not mapping[sid]['active_concept'][body.kind+'_prompt'].strip() for sid in selected):
            raise HTTPException(409, 'Every selected segment needs a current prompt for this media type. Create or review that prompt first.')
        pending, skipped, duration_notes = [], [], []
        previous = desktop.rows()
        for sid in selected:
            s = mapping[sid]
            c = s['active_concept']
            seconds = (s['end_ms']-s['start_ms'])/1000
            duration = next((d for d in (4,6,8,10) if d >= seconds), 10) if body.kind == 'video' and body.duration_mode == 'srt' else body.duration
            if body.kind == 'video':
                duration_notes.append({'segment_id':sid,'scene_seconds':seconds,'generation_seconds':duration,'short':duration < seconds})
            duplicate = False
            for old in previous:
                p = json.loads(old['payload'])
                if old['state'] in ('QUEUED','SUBMITTING','RUNNING','DOWNLOADING','COMPLETED') and media_is_current(data['video'],data['document'],s,p) and p['kind'] == body.kind and p.get('orientation') == body.orientation and (body.kind == 'image' and p.get('image_model') == body.image_model or body.kind == 'video' and p.get('duration') == duration):
                    duplicate = True
            if duplicate and not body.regenerate:
                skipped.append(sid)
                continue
            try:
                pending.append(desktop.Job(kind=body.kind, project_id=data['video']['project_id'], video_id=video_id, document_id=data['document']['id'], segment_id=sid, concept_id=c['id'], start_ms=s['start_ms'], end_ms=s['end_ms'], label=f"Segment {s['ordinal']:03d}", prompt=c['image_prompt'] if body.kind=='image' else c['video_prompt'], orientation=body.orientation, duration=duration, image_model=body.image_model))
            except ValidationError as exc:
                # Stored data can bypass request validation. Identify the scene
                # without exposing prompt content or partially enqueueing a batch.
                detail = '; '.join(f"{'.'.join(map(str, error['loc']))}: {error['msg']}" for error in exc.errors(include_input=False, include_url=False))
                raise HTTPException(422, f"Scene {s['ordinal']:03d}: {detail}") from exc
        result = await desktop.enqueue(desktop.Batch(jobs=pending)) if pending else {'ids': []}
        return {**result, 'skipped': skipped, 'durations': duration_notes}


class RetryBody(GenerateBody):
    kind: Literal['concept','image','video']
    reviewed: bool = False


@router.post('/videos/{video_id}/retry-failed')
async def retry_failed(video_id: str, body: RetryBody):
    from agent.api import desktop
    data = await read_document(video_id)
    segments = {s['id']:s for s in data['segments']}
    selected = list(dict.fromkeys(body.segment_ids))
    if any(sid not in segments for sid in selected):
        raise HTTPException(400, 'All scenes must belong to the active project.')
    terminal = {'FAILED','NEEDS_REVIEW','INTERRUPTED','CANCELLED'}
    if body.kind == 'concept':
        options = await prompt_options(data['document']['id'])
        def failed(sid):
            segment=segments[sid]
            target = ('image' if options.row_instructions.get(sid,'video' if segment['ordinal']<=options.video_row_count else 'image')=='image' else 'video') if body.use_row_instructions else body.prompt_kind
            job=segment['prompt_jobs'].get(target) if target!='both' else segment['job']
            return job and job['state'] in terminal
        eligible = [sid for sid in selected if failed(sid)]
        if eligible and not body.reviewed:
            raise HTTPException(409, 'Review failed ChatGPT requests before retrying. A new request may use credits.')
        result = await generate_concepts(video_id, GenerateBody(segment_ids=eligible, provider=body.provider, model=body.model, prompt_kind=body.prompt_kind, regenerate=True, use_row_instructions=body.use_row_instructions, batch_size=body.batch_size, composer_mode=body.composer_mode)) if eligible else {'ids':[], 'skipped':[]}
        return {**result, 'skipped':list(set(selected)-set(eligible)) + result.get('skipped',[]), 'resumed':[]}
    async with _db_lock:
        data = await read_document(video_id)
        segments = {s['id']:s for s in data['segments']}
        if any(sid not in segments for sid in selected):
            raise HTTPException(409, 'Scenes changed. Refresh before retrying.')
        jobs = desktop.rows()
        retry, skipped = [], []
        for sid in selected:
            segment = segments[sid]
            matching = [j for j in jobs if (p:=json.loads(j['payload'])).get('segment_id') == sid
                and media_is_current(data['video'],data['document'],segment,p)
                and p.get('kind') == body.kind and p.get('start_ms') == segment['start_ms'] and p.get('end_ms') == segment['end_ms']]
            if not segment['ready'] or not matching or any(j['state'] in {'QUEUED','RUNNING','SUBMITTING','DOWNLOADING','COMPLETED'} for j in matching):
                skipped.append(sid)
            elif matching[0]['state'] in terminal:
                retry.append(matching[0])
            else:
                skipped.append(sid)
        if any(not j['remote'] or j['state'] != 'FAILED' for j in retry) and not body.reviewed:
            raise HTTPException(409, 'Inspect failed scenes in Flow first. Confirm review before submitting a new generation.')
        new_jobs = [desktop.Job.model_validate_json(j['payload']) for j in retry if not j['remote'] or j['state'] != 'FAILED']
        result = await desktop.enqueue_jobs(desktop.Batch(jobs=new_jobs), preserve_settings=True) if new_jobs else {'ids':[]}
        resumed = []
        for job in retry:
            if job['remote'] and job['state'] == 'FAILED':
                await desktop.resume(job['id'])
                resumed.append(job['id'])
        return {**result,'resumed':resumed,'skipped':skipped}
