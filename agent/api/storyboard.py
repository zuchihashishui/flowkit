"""Script/audio -> timed segments -> versioned concepts -> existing media queue."""
import asyncio
import json
import math
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
from pydantic import BaseModel, Field, ConfigDict, model_validator
from agent.db.schema import get_db, _db_lock
from agent.config import OUTPUT_DIR
from agent.services.concept_writer import Concept, write_concept

router = APIRouter(prefix='/storyboard', tags=['storyboard'])
AUDIO_DIR = OUTPUT_DIR / 'script_audio'


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
            await db.execute('UPDATE script_document SET script_text=?,visual_style=?,revision=revision+?,updated=? WHERE id=?', (body.script_text, body.visual_style, int(changed), time.time(), d['id']))
        else:
            await db.execute('INSERT INTO script_document(id,video_id,script_text,visual_style,created,updated) VALUES(?,?,?,?,?,?)', (uid(), video_id, body.script_text, body.visual_style, time.time(), time.time()))
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
    if not docs:
        return {'video': video, 'document': None, 'segments': [], 'warnings': []}
    doc = docs[0]
    provenance = await query('SELECT kind,source_id,imported FROM document_source WHERE document_id=?', (doc['id'],))
    doc['source'] = provenance[0] if provenance else None
    segments = await query('SELECT * FROM script_segment WHERE document_id=? ORDER BY ordinal', (doc['id'],))
    concepts = await query('SELECT c.* FROM scene_concept c JOIN script_segment s ON s.id=c.segment_id WHERE s.document_id=? ORDER BY c.version DESC', (doc['id'],))
    jobs = await query('SELECT j.id,j.segment_id,j.state,j.error,j.created FROM concept_job j JOIN script_segment s ON s.id=j.segment_id WHERE s.document_id=? ORDER BY j.created DESC', (doc['id'],))
    from agent.api.desktop import rows
    media = rows()
    warnings = []
    previous_end = 0
    for s in segments:
        s['concepts'] = [c for c in concepts if c['segment_id'] == s['id']]
        active = next((c for c in s['concepts'] if c['id'] == s['active_concept_id']), None)
        s['active_concept'] = active
        s['ready'] = bool(active and active['segment_revision'] == s['revision'] and active['document_revision'] == doc['revision'])
        s['image_ready']=bool(s['ready'] and active['image_prompt'].strip())
        s['video_ready']=bool(s['ready'] and active['video_prompt'].strip())
        s['job'] = next((j for j in jobs if j['segment_id'] == s['id']), None)
        s['media_jobs'] = []
        for j in media:
            payload = json.loads(j['payload'])
            if payload.get('segment_id') == s['id']:
                s['media_jobs'].append({'id': j['id'], 'state': j['state'], 'kind': payload['kind'], 'concept_id': payload.get('concept_id'), 'current': media_is_current(video, doc, s, payload), 'files': json.loads(j['files']), 'error': j['error'], 'can_resume': bool(j['remote'])})
        if s['start_ms'] > previous_end:
            warnings.append(f"Gap before segment {s['ordinal']}: {s['start_ms'] - previous_end} ms. Timestamps are preserved.")
        previous_end = s['end_ms']
        if doc['audio_duration_ms'] and s['end_ms'] > doc['audio_duration_ms'] + 100:
            warnings.append(f"Segment {s['ordinal']} extends beyond the audio duration.")
    if doc['audio_duration_ms'] and previous_end < doc['audio_duration_ms']:
        warnings.append(f"Audio continues {doc['audio_duration_ms'] - previous_end} ms after the last segment.")
    return {'video': video, 'document': doc, 'segments': segments, 'warnings': warnings}


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


class GenerateBody(BaseModel):
    segment_ids: list[str] = Field(min_length=1, max_length=200)
    provider: Literal['codex','claude','agy','chatgpt-web'] = 'codex'
    model: str | None = Field(default=None, max_length=100, pattern=r'^[^-\s][^\r\n]*$')
    regenerate: bool = False
    prompt_kind: Literal['both','image','video'] = 'both'


@router.post('/videos/{video_id}/generate-concepts')
async def generate_concepts(video_id: str, body: GenerateBody):
    if body.provider == 'chatgpt-web':
        from agent.services.chatgpt_gateway import status
        info = await status()
        if not info.get('available') or not info.get('extensionConnected') or info.get('needsReview'):
            raise HTTPException(503, 'Connect ChatGPT Web and resolve pending review in Settings first.')
    elif not shutil.which(body.provider):
        raise HTTPException(503, f'{body.provider} CLI is not installed or not on PATH. Install and sign in to it before creating concepts.')
    project_settings = None
    if body.provider=='chatgpt-web' and body.prompt_kind in {'image','video'}:
        from agent.services.chatgpt_gateway import ensure_project_workers
        from agent.services.project_settings import get
        video=await one('SELECT project_id FROM video WHERE id=?',(video_id,))
        project_settings=await get(video['project_id'])
        try:
            await ensure_project_workers()
        except ValueError as error:
            raise HTTPException(503,str(error)) from error
    ids, skipped = [], []
    async with transaction() as db:
        doc = await one('SELECT * FROM script_document WHERE video_id=?', (video_id,))
        segments = await query('SELECT * FROM script_segment WHERE document_id=? ORDER BY ordinal', (doc['id'],))
        mapping = {s['id']: (i,s) for i,s in enumerate(segments)}
        if any(sid not in mapping for sid in body.segment_ids):
            raise HTTPException(400, 'All selected segments must belong to this collection.')
        for sid in dict.fromkeys(body.segment_ids):
            i,s = mapping[sid]
            active = await query('SELECT * FROM scene_concept WHERE id=?', (s['active_concept_id'],))
            ready = active and active[0]['segment_revision'] == s['revision'] and active[0]['document_revision'] == doc['revision']
            pending = await query("SELECT id FROM concept_job WHERE segment_id=? AND state IN ('QUEUED','RUNNING')", (sid,))
            target_ready=ready and (bool(active[0][body.prompt_kind+'_prompt'].strip()) if body.prompt_kind!='both' else bool(active[0]['image_prompt'].strip() and active[0]['video_prompt'].strip()))
            if pending or (target_ready and not body.regenerate):
                skipped.append(sid)
                continue
            payload = {**body.model_dump(exclude={'segment_ids','regenerate'}), 'text': s['text'], 'start_ms': s['start_ms'], 'end_ms': s['end_ms'], 'segment_revision': s['revision'], 'document_revision': doc['revision'], 'active_concept_id': s['active_concept_id'], 'visual_style': doc['visual_style'], 'script_context': doc['script_text'][:8000], 'previous_text': segments[i-1]['text'][:1000] if i else '', 'next_text': segments[i+1]['text'][:1000] if i+1<len(segments) else ''}
            if project_settings is not None:
                payload['project_settings']=project_settings
                payload['retained_prompt']=active[0]['video_prompt' if body.prompt_kind=='image' else 'image_prompt'] if ready else ''
            jid = uid()
            await db.execute("INSERT INTO concept_job(id,segment_id,state,payload,created) VALUES(?,?,'QUEUED',?,?)", (jid, sid, json.dumps(payload), time.time()))
            ids.append(jid)
    return {'ids': ids, 'skipped': skipped}


@router.post('/videos/{video_id}/cancel-concepts')
async def cancel_concepts(video_id: str):
    async with transaction() as db:
        result = await db.execute("UPDATE concept_job SET state='CANCELLED' WHERE state='QUEUED' AND segment_id IN (SELECT s.id FROM script_segment s JOIN script_document d ON d.id=s.document_id WHERE d.video_id=?)", (video_id,))
    return {'cancelled': result.rowcount}


async def process_concept(job):
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


async def run():
    async with transaction() as db:
        await db.execute("UPDATE concept_job SET state='NEEDS_REVIEW',error='App stopped during AI generation. Check before submitting again.' WHERE state='RUNNING'")
    tasks = {}
    try:
        while True:
            for jid, task in list(tasks.items()):
                if task.done():
                    task.result()
                    del tasks[jid]
            from agent.services.chatgpt_gateway import status
            info = await status()
            slots = info.get('availableSlots',0)
            pending = await query("SELECT * FROM concept_job WHERE state='QUEUED' ORDER BY created LIMIT 200")
            for job in pending:
                if len(tasks) >= 3:
                    break
                if job['id'] in tasks:
                    continue
                if json.loads(job['payload']).get('provider') == 'chatgpt-web':
                    if slots <= 0:
                        continue
                    slots -= 1
                elif tasks:
                    continue
                tasks[job['id']] = asyncio.create_task(process_concept(job))
            await asyncio.sleep(1)
    finally:
        for task in tasks.values():
            task.cancel()
        await asyncio.gather(*tasks.values(),return_exceptions=True)


@router.post('/videos/{video_id}/audio')
async def upload_audio(video_id: str, audio: UploadFile = File(...)):
    doc = await one('SELECT * FROM script_document WHERE video_id=?', (video_id,))
    suffix = Path(audio.filename or '').suffix.lower()
    if suffix not in ('.mp3','.wav','.m4a','.flac','.ogg','.aac','.mp4'):
        raise HTTPException(400, 'Choose an MP3, WAV, M4A, FLAC, OGG, AAC or MP4 audio file.')
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    dest = AUDIO_DIR / (uid() + suffix)
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
    if not path.is_relative_to(AUDIO_DIR.resolve()) or not path.is_file():
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
            pending.append(desktop.Job(kind=body.kind, project_id=data['video']['project_id'], video_id=video_id, document_id=data['document']['id'], segment_id=sid, concept_id=c['id'], start_ms=s['start_ms'], end_ms=s['end_ms'], label=f"Segment {s['ordinal']:03d}", prompt=c['image_prompt'] if body.kind=='image' else c['video_prompt'], orientation=body.orientation, duration=duration, image_model=body.image_model))
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
        eligible = [sid for sid in selected if (not segments[sid]['ready'] or (body.prompt_kind!='both' and not segments[sid]['active_concept'][body.prompt_kind+'_prompt'].strip())) and segments[sid]['job'] and segments[sid]['job']['state'] in terminal]
        if eligible and not body.reviewed:
            raise HTTPException(409, 'Review failed ChatGPT requests before retrying. A new request may use credits.')
        result = await generate_concepts(video_id, GenerateBody(segment_ids=eligible, provider=body.provider, model=body.model, prompt_kind=body.prompt_kind)) if eligible else {'ids':[], 'skipped':[]}
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
