"""Summaries of existing durable records; never enqueue, acknowledge or retry work.

File readiness is checked against the selected video's ownership. Storyboard
readiness reuses the same source-revision rules as generation and assembly.
"""
import asyncio
from collections import Counter
import json
import os
from pathlib import Path
import shutil
import time

from fastapi import HTTPException

from agent.db.schema import get_db
from agent.services import workflow_scope as scope

STAGES = [
    ('elevenlabs', 'Narration'), ('whisperx', 'Transcript JSON'), ('srt', 'SRT / scenes'),
    ('image_prompts', 'Image prompts'), ('video_prompts', 'Video prompts'),
    ('images', 'Images'), ('videos', 'Video clips'), ('assembly', 'Final video'),
]
ACTIVE = {'RUNNING', 'SUBMITTING', 'DOWNLOADING', 'PROCESSING'}
REVIEW = {'NEEDS_REVIEW', 'WAITING_COMMIT', 'SUBMISSION_UNCERTAIN'}


def services():
    from agent.api import elevenlabs, whisperx, srt, assembly
    return elevenlabs.bridge, whisperx.service, srt.service, assembly.service


async def selected_videos(project_id, video_id=None):
    db = await get_db()
    project = await (await db.execute("SELECT id FROM project WHERE id=? AND status!='DELETED'", (project_id,))).fetchone()
    if not project:
        raise HTTPException(404, 'Project not found.')
    if video_id:
        from agent.api.workflow import context
        await context(project_id, video_id)
    rows = await (await db.execute('SELECT id,project_id,title,display_order FROM video WHERE project_id=? ORDER BY display_order,created_at', (project_id,))).fetchall()
    return [dict(row) for row in rows if not video_id or row['id'] == video_id]


def file_ready(path):
    try:
        path = Path(path)
        return path.is_file() and path.stat().st_size > 0
    except (OSError, ValueError, TypeError):
        return False


def resource_available(item):
    el, wx, sub, assembly = services()
    kind, rid = item['resource_kind'], item['id']
    try:
        if kind == 'elevenlabs':
            return file_ready(el.audio_path(rid, 'merged'))
        if kind == 'audio':
            return file_ready(wx.resolve_source(rid)[1])
        if kind == 'whisperx':
            return file_ready(wx.result_path(rid))
        if kind == 'json':
            return file_ready(sub.output / (rid + '.json'))
        if kind == 'srt':
            return file_ready(sub.result_path(rid, require_approved=True))
        if kind == 'asset':
            return file_ready(assembly.path(assembly.asset(rid)))
        if kind == 'assembly':
            return file_ready(assembly.result_path(rid))
    except (OSError, ValueError, KeyError):
        return False
    return False


def source_brief(item):
    return {'id': item['id'], 'kind': item['resource_kind'], 'title': item['title'],
            'available': resource_available(item), 'state': item['state'], 'sources': item['sources']}


def lineage(source, resources):
    """Follow only saved source IDs, not the newest job or a matching filename."""
    mapping = {(r['resource_kind'], r['id']): r for r in resources}
    visited, pending = set(), []
    if source and source.get('source_id'):
        pending.append((source['kind'], source['source_id']))
    while pending:
        key = pending.pop()
        if key in visited:
            continue
        visited.add(key)
        parent = mapping.get(key)
        if parent:
            pending.extend((s['kind'], s['id']) for s in parent['sources'])
    return visited


def job_brief(job):
    keys = ('id', 'state', 'error', 'created', 'phase', 'progress', 'total_chunks',
            'completed_chunks', 'saved_scenes', 'recoverable_downloads', 'can_resume')
    return {key: job[key] for key in keys if key in job}


def stage_summary(sid, ready, total, jobs, *, optional=False, available_count=None):
    jobs = sorted(jobs, key=lambda j: j.get('created') or 0, reverse=True)
    counts = Counter(j['state'] for j in jobs)
    if total and ready >= total:
        status = 'ready'
    elif any(counts[s] for s in ACTIVE):
        status = 'running'
    elif any(counts[s] for s in REVIEW):
        status = 'needs_review'
    elif counts['QUEUED']:
        status = 'queued'
    elif counts['FAILED'] or counts['INTERRUPTED']:
        status = 'failed'
    else:
        status = 'partial' if ready else 'pending'
    return {'id': sid, 'label': dict(STAGES)[sid], 'status': status,
            'ready': ready, 'total': total, 'optional': optional,
            'available_count': ready if available_count is None else available_count,
            'failed': counts['FAILED'] + counts['INTERRUPTED'],
            'needs_review': sum(counts[s] for s in REVIEW), 'queued': counts['QUEUED'],
            'running': sum(counts[s] for s in ACTIVE),
            'latest_job': job_brief(jobs[0]) if jobs else None}


async def jobs_for_video(ctx):
    from agent.api import desktop
    el, wx, sub, assembly = services()
    jobs = []
    for kind, service in [('elevenlabs', el), ('whisperx', wx), ('srt', sub), ('assembly', assembly)]:
        for job in service.jobs(ctx):
            result = {**job, **ctx, 'kind': kind, 'stage': kind}
            if job['state'] == 'COMPLETED':
                if kind == 'srt':
                    try:
                        result['result_saved'] = file_ready(sub.result_path(job['id']))
                    except (ValueError, KeyError, OSError):
                        result['result_saved'] = False
                else:
                    result['result_saved'] = resource_available({'resource_kind':kind, 'id':job['id']})
            jobs.append(result)
    db = await get_db()
    rows = await (await db.execute('''SELECT j.*,s.ordinal FROM concept_job j
        JOIN script_segment s ON s.id=j.segment_id JOIN script_document d ON d.id=s.document_id
        WHERE d.video_id=? ORDER BY j.created DESC''', (ctx['video_id'],))).fetchall()
    for row in rows:
        job = dict(row)
        payload = json.loads(job.pop('payload'))
        job.update(ctx, kind='concept', stage='video_prompts' if payload.get('prompt_kind') == 'video' else 'image_prompts',
                   prompt_kind=payload.get('prompt_kind', 'both'), title=f"Scene {job['ordinal']}")
        jobs.append(job)
    for row in desktop.rows():
        payload = json.loads(row['payload'])
        if payload.get('project_id') != ctx['project_id'] or payload.get('video_id') != ctx['video_id']:
            continue
        if payload.get('kind') not in {'image', 'video'}:
            continue
        jobs.append({**{k: v for k, v in row.items() if k not in {'payload', 'remote', 'files'}}, **ctx,
                     'kind': payload['kind'], 'stage': 'videos' if payload['kind'] == 'video' else 'images',
                     'segment_id': payload.get('segment_id'), 'title': payload.get('prompt', '')[:100],
                     'files_saved': len(json.loads(row['files'])),
                     'result_saved': any(file_ready(f) for f in json.loads(row['files'])),
                     'can_resume': row['state'] == 'FAILED' and bool(row['remote'])})
    return sorted(jobs, key=lambda j: j.get('created') or 0, reverse=True)


def matching_srt(assembly, asset_id, segments):
    from agent.services.assembly_service import cues_from_srt
    try:
        asset = assembly.asset(asset_id, 'srt')
        _, cues = cues_from_srt(assembly.path(asset).read_bytes())
        return len(cues) == len(segments) and all(
            abs(c['start'] * 1000 - s['start_ms']) <= 1 and abs(c['end'] * 1000 - s['end_ms']) <= 1
            and ''.join(c['text'].split()) == ''.join(s['text'].split()) for c, s in zip(cues, segments))
    except (OSError, ValueError, KeyError):
        return False


def assembly_current(job, segments, document, owned_resources):
    """An old MP4 remains saved but is not reported as the current scene render."""
    _, _, _, assembly = services()
    if not resource_available({'resource_kind': 'assembly', 'id': job['id']}):
        return False
    with assembly.db() as db:
        row = db.execute('SELECT plan FROM assembly_jobs WHERE id=?', (job['id'],)).fetchone()
    plan = json.loads(row['plan'])
    owned_ids = {r['id'] for r in owned_resources if r['resource_kind'] == 'asset'}
    inputs = [plan['audio_id'], plan['srt_id'], *plan.get('image_ids', []), *plan.get('video_ids', [])]
    if any(aid not in owned_ids for aid in inputs):
        return False
    if not document or not segments:
        return True  # A manually assembled video need not have storyboard scenes.
    if not matching_srt(assembly, plan['srt_id'], segments):
        return False
    valid_jobs = {j['id'] for s in segments for j in s['media_jobs'] if j['current']}
    for scene in plan.get('scenes', []):
        if not scene.get('asset_id'):
            return False
        asset = assembly.asset(scene['asset_id'])
        generated = asset['metadata'].get('media_job_id')
        if generated and generated not in valid_jobs:
            return False
    return True


async def video_overview(video, resources):
    from agent.api import storyboard, desktop
    ctx = {'project_id': video['project_id'], 'video_id': video['id']}
    owned = scope.select(resources, **ctx)
    data = await storyboard.read_document(video['id'])
    doc, segments = data['document'], data['segments']
    jobs = await jobs_for_video(ctx)
    source = doc.get('source') if doc else None
    ancestry = lineage(source, owned)
    sources = {'audio': [], 'json': [], 'srt': [], 'document_source': source}
    for item in owned:
        kind = item['resource_kind']
        category = ('audio' if kind in {'elevenlabs', 'audio'} or (kind == 'asset' and item['asset_type'] == 'audio')
                    else 'json' if kind in {'whisperx', 'json'}
                    else 'srt' if kind == 'srt' or (kind == 'asset' and item['asset_type'] == 'srt') else None)
        if category:
            brief = source_brief(item)
            brief['in_scene_lineage'] = (kind, item['id']) in ancestry
            sources[category].append(brief)
    def stage_sources(category):
        current = [s for s in sources[category] if s['in_scene_lineage']]
        return current or sources[category]
    bystage = {sid: [j for j in jobs if j['stage'] == sid or
                    (j['kind'] == 'concept' and j['prompt_kind'] == 'both' and sid in {'image_prompts', 'video_prompts'})] for sid, _ in STAGES}
    stages = []
    for sid, category in [('elevenlabs', 'audio'), ('whisperx', 'json'), ('srt', 'srt')]:
        available = sum(s['available'] for s in stage_sources(category))
        # Imported scene text is usable even when its source was entered manually.
        ready = int(bool(segments) or bool(available)) if sid == 'srt' and not (source or {}).get('source_id') else int(bool(available))
        stages.append(stage_summary(sid, ready, 1, bystage[sid], available_count=available))
    saved_scene_ids = set()
    for kind in ['image', 'video']:
        eligible = [s for s in segments if s.get(kind + '_ready')]
        stages.append(stage_summary(kind + '_prompts', len(eligible), len(segments), bystage[kind + '_prompts'], optional=kind == 'video'))
        saved = 0
        for segment in segments:
            current = [j for j in segment['media_jobs'] if j['kind'] == kind and j['state'] == 'COMPLETED' and j['current']]
            if any(any(Path(f).resolve().is_relative_to(desktop.ROOT.resolve()) and file_ready(f) for f in j['files']) for j in current):
                saved += 1
                saved_scene_ids.add(segment['id'])
        stages.append(stage_summary('images' if kind == 'image' else 'videos', saved,
                                   len(segments) if kind == 'image' else len(eligible),
                                   bystage['images' if kind == 'image' else 'videos'], optional=kind == 'video'))
    rendered = [j for j in bystage['assembly'] if j['state'] == 'COMPLETED' and assembly_current(j, segments, doc, owned)]
    stages.append(stage_summary('assembly', int(bool(rendered)), 1, bystage['assembly'], available_count=len(rendered)))
    stages.sort(key=lambda stage: [s for s, _ in STAGES].index(stage['id']))
    prompt_coverage = sum(bool(s['image_ready'] or s['video_ready']) for s in segments)
    status_by_id = {s['id']: s['status'] for s in stages}
    next_stage = None
    next_reason = 'Current final video is saved.'
    if not rendered and segments and prompt_coverage < len(segments):
        next_stage, next_reason = 'image_prompts', 'Create a prompt for each scene that still needs one; video prompts are optional alternatives.'
    elif not rendered and segments and len(saved_scene_ids) < len(segments):
        missing = [s for s in segments if s['id'] not in saved_scene_ids]
        next_stage = 'images' if any(s['image_ready'] for s in missing) else 'videos'
        next_reason = 'Generate missing scene visuals. A current video clip can replace an image.'
    elif not rendered and segments:
        next_stage, next_reason = ('assembly', 'Select matching narration, SRT and scene media to render.') if status_by_id['elevenlabs'] == 'ready' else ('elevenlabs', 'Create or import the narration needed for the final video.')
    elif not rendered and status_by_id['srt'] == 'ready':
        next_stage, next_reason = 'srt', 'Import the saved SRT into this video to create editable scenes.'
    elif not rendered and status_by_id['whisperx'] == 'ready':
        next_stage, next_reason = 'srt', 'Choose the transcript JSON and create the SRT.'
    elif not rendered and status_by_id['elevenlabs'] == 'ready':
        next_stage, next_reason = 'whisperx', 'Choose the saved narration and create the transcript JSON.'
    elif not rendered:
        next_stage, next_reason = 'elevenlabs', 'Create narration or import an existing audio file.'
    summary = {'needs_review':sum(j['state'] in REVIEW for j in jobs),
               'failed':sum(j['state'] in {'FAILED','INTERRUPTED'} for j in jobs),
               'running':sum(j['state'] in ACTIVE for j in jobs), 'queued':sum(j['state'] == 'QUEUED' for j in jobs)}
    warnings = list(data['warnings'])
    if source and not ancestry.intersection({(r['resource_kind'], r['id']) for r in owned}):
        warnings.append('The scene source has no saved resource link. Select matching inputs explicitly at each stage.')
    return {**video, 'scene_count': len(segments), 'stages': stages, 'next_stage': next_stage, 'next_stage_reason':next_reason,
            'coverage': {'prompts':prompt_coverage, 'visuals':len(saved_scene_ids), 'total':len(segments)},
            'summary': summary, 'sources': sources, 'warnings': warnings, 'manual_stages': True}


async def overview(project_id, video_id=None):
    videos = await selected_videos(project_id, video_id)
    resources = scope.catalog()
    return {'protocol': 1, 'project_id': project_id, 'manual_stages': True, 'generated_at': time.time(),
            'videos': [await video_overview(video, resources) for video in videos]}


def recovery_advice(job):
    state, kind = job['state'], job['kind']
    action, message = None, 'Saved result retained.'
    downloaded = int(job.get('recoverable_downloads') or 0)
    if state in ACTIVE or state == 'QUEUED':
        action, message = 'wait', 'The durable queue retains this job. Do not submit it again.'
    elif downloaded:
        action, message = 'recover_download', 'Saved browser download metadata exists. Recover audio before considering another generation.'
    elif state in REVIEW:
        action, message = 'inspect', 'Inspect the provider page and downloads first. Submission may already have consumed credits; no automatic resend.'
    elif kind == 'assembly' and job.get('can_resume'):
        action, message = 'resume_render', 'Resume this local render and reuse valid saved scene clips.'
    elif kind in {'image', 'video'} and job.get('can_resume'):
        action, message = 'resume_download', 'Resume polling/downloading the existing remote result without generating again.'
    elif state in {'FAILED', 'CANCELLED', 'INTERRUPTED'}:
        action = 'retry_local' if kind == 'whisperx' else 'retry'
        message = 'Retry is manual. Existing saved outputs remain available.'
    elif state == 'COMPLETED' and kind == 'elevenlabs' and not job.get('merged_url'):
        action, message = 'recover_download', 'Completed chunks are retained but merged narration is unavailable. Open audio recovery to merge the saved chunks; do not generate speech again.'
    elif state == 'COMPLETED' and job.get('result_saved') is False:
        action, message = 'inspect', 'The job completed but its saved output is missing or empty. Check the output folder and backup before generating again.'
    elif state == 'COMPLETED' and kind == 'srt' and job.get('quality') and job['quality'].get('status') not in {'LEGACY','PASSED'} and not job['quality'].get('approved'):
        action, message = 'inspect', 'The SRT is saved. Review its quality report and accept timing exceptions before using it in the next stage.'
    return {**{k: v for k, v in job.items() if k not in {'prompt', 'options', 'quality'}},
            'action': action, 'message': message, 'download_recoverable': downloaded,
            'can_resume': bool(job.get('can_resume'))}


async def recovery(project_id, video_id=None):
    videos = await selected_videos(project_id, video_id)
    jobs = []
    for video in videos:
        ctx = {'project_id': project_id, 'video_id': video['id']}
        jobs.extend(recovery_advice(job) for job in await jobs_for_video(ctx))
    counts = {'queued': sum(j['state'] == 'QUEUED' for j in jobs),
              'running': sum(j['state'] in ACTIVE for j in jobs),
              'needs_review': sum(j['state'] in REVIEW for j in jobs),
              'failed': sum(j['state'] in {'FAILED', 'INTERRUPTED'} for j in jobs),
              'resumable': sum(j['can_resume'] for j in jobs),
              'download_recoverable': sum(j['download_recoverable'] for j in jobs)}
    return {'protocol': 1, 'project_id': project_id, 'manual_stages': True,
            'automatic_resubmit': False, 'retained_results':sum(j['state'] == 'COMPLETED' and j['action'] is None for j in jobs),
            'counts': counts, 'jobs': [j for j in jobs if j['action'] is not None]}


def storage_checks(path):
    """Inspect the closest existing directory without making user files."""
    path = Path(path).resolve()
    parent = path
    while not parent.exists() and parent.parent != parent:
        parent = parent.parent
    checks = [{'id': 'output_writable', 'status': 'pass' if parent.is_dir() and os.access(parent, os.W_OK) else 'fail',
               'message': f'Output folder: {path}. Access check only; actual writes are verified when saving.'}]
    try:
        free = shutil.disk_usage(parent).free
        checks.append({'id': 'disk_space', 'status': 'fail' if free < 64 * 1024**2 else 'warn' if free < 2 * 1024**3 else 'pass',
                       'message': f'{free / 1024**3:.1f} GiB free. Final render space depends on source duration and resolution.'})
    except OSError as error:
        checks.append({'id': 'disk_space', 'status': 'fail', 'message': str(error)})
    return checks


async def preflight(body):
    from agent.api import storyboard, desktop
    from agent.services import project_settings, chatgpt_gateway
    from agent.services.flow_client import get_flow_client
    stage = 'image_prompts' if body['stage'] == 'prompts' else body['stage']
    cli_prompt = stage in {'image_prompts', 'video_prompts'} and body.get('provider', 'chatgpt-web') != 'chatgpt-web'
    ctx = {'project_id': body['project_id'], 'video_id': body['video_id']}
    await selected_videos(**ctx)
    settings = await project_settings.get(ctx['project_id'])
    el, wx, sub, assembly = services()
    checks = []
    def add(cid, ok, message, warn=False):
        checks.append({'id': cid, 'status': 'pass' if ok else 'warn' if warn else 'fail', 'message': message})
    url_key = {'elevenlabs': 'elevenlabs_url', 'srt': 'chatgpt_url', 'image_prompts': 'image_prompt_url',
               'video_prompts': 'video_prompt_url', 'images': 'google_flow_url', 'videos': 'google_flow_url'}.get(stage)
    if url_key and not cli_prompt:
        try:
            project_settings.validate_url(url_key, settings[url_key])
            add('project_url', True, 'Saved project destination: ' + settings[url_key])
        except (ValueError, KeyError) as error:
            add('project_url', False, 'Save a valid destination in Project Settings. ' + str(error))
    if stage in {'elevenlabs', 'whisperx', 'assembly'}:
        for binary in ['ffmpeg', 'ffprobe']:
            add(binary, bool(shutil.which(binary)), binary + (' is ready.' if shutil.which(binary) else ' is missing. Install it and restart Studio.'))
    if stage == 'elevenlabs':
        status = el.status()
        add('extension', status['connected'] and status['enabled'], 'ElevenLabs extension must be connected and switched on.')
        add('extension_protocol', el.project_urls and el.auto_prepare_tab, 'ElevenLabs extension must support project URLs and automatic tab preparation. Reload the updated extension if missing.')
        add('queue_review', not status['reviewRequired'], 'Review and release uncertain ElevenLabs work before starting more speech.')
        add('queue_paused', not status['settings']['paused'], 'ElevenLabs queue is paused.' if status['settings']['paused'] else 'ElevenLabs queue is enabled.')
        if body.get('text') is not None:
            add('text', bool(body['text'].strip()), 'Enter narration text before generating speech.')
        else:
            add('text', False, 'Narration text will be checked when you submit the form.', warn=True)
        add('credits', False, 'Credits are optional page information; an unreadable balance does not block generation.', warn=True)
    if cli_prompt:
        provider = body['provider']
        add('cli_provider', bool(shutil.which(provider)), provider + ' CLI must be installed and signed in. This check does not send a prompt.')
    if stage in {'srt', 'image_prompts', 'video_prompts'} and not cli_prompt:
        status = await chatgpt_gateway.status()
        add('gateway', status.get('available') is True, 'ChatGPT gateway protocol 2 must be running.')
        add('extension', bool(status.get('extensionConnected') and status.get('enabled')), 'ChatGPT extension must be connected and switched on.')
        caps = status.get('capabilities', [])
        required = {'project-urls-v1'} | ({'dedicated-srt-v1', 'json-attachment-v1', 'fresh-srt-tab-v1'} if stage == 'srt' else set())
        add('extension_protocol', required.issubset(caps), 'Required ChatGPT capabilities: ' + ', '.join(sorted(required)) + '.')
        add('queue_review', not (status.get('needsReview') or status.get('hasReviewJobs')), 'Review uncertain ChatGPT requests before starting new work.')
        add('queue_paused', not status.get('settings', {}).get('paused'), 'ChatGPT queue must be resumed.')
        add('slots', bool(status.get('availableSrtSlots' if stage == 'srt' else 'availableSlots')), 'Busy workers will finish active requests; new work waits in the queue.', warn=True)
    if stage in {'images', 'videos'}:
        flow = get_flow_client()
        add('extension', flow.connected, 'Google Flow extension must be connected.')
        add('extension_protocol', any(s.get('project_urls') for s in flow._extensions.values()), 'Google Flow extension must support project URLs. Reload the updated extension if missing.')
        add('queue_paused', not desktop.paused, 'Google Flow queue must be resumed.')
        guard = flow.generation_guard_status
        add('rate_limit', not guard.get('cooldown_active'), 'Provider cooldown is active; submissions wait until it expires.', warn=True)
    owned = scope.select(scope.catalog(), **ctx)
    if stage in {'whisperx', 'srt'}:
        accepted = {'elevenlabs', 'audio'} if stage == 'whisperx' else {'whisperx', 'json'}
        candidates = [r for r in owned if r['resource_kind'] in accepted]
        sid, kind = body.get('source_id'), body.get('source_kind')
        if sid:
            candidates = [r for r in candidates if r['id'] == sid and (not kind or r['resource_kind'] == kind)]
        available = [r for r in candidates if resource_available(r)]
        add('source', bool(available), 'The selected source is saved and belongs to this video.' if available else 'Choose a saved ' + ('merged/imported audio' if stage == 'whisperx' else 'transcript JSON') + ' belonging to this video.')
        if not sid and len(available) > 1:
            add('source_selection', False, 'Several sources are available. Choose the intended version explicitly before submitting.', warn=True)
    if stage == 'whisperx':
        try:
            info = await asyncio.wait_for(wx.check(), timeout=20)
            add('whisperx_environment', bool(info.get('ok')), 'WhisperX environment check passed.' if info.get('ok') else str(info.get('error') or 'WhisperX imports or dependencies are unavailable.'))
            from agent.services.production_settings import effective
            device = body.get('device') or (await effective(ctx))['whisperx']['device']
            if device == 'cuda' and info.get('ok'):
                add('cuda', info.get('cuda_available') is True, 'GPU transcription requires CUDA in the WhisperX environment. Choose CPU explicitly if CUDA is unavailable.')
            add('model', False, 'This check does not download a model or transcribe audio. The first model load may need network access.', warn=True)
        except asyncio.TimeoutError:
            add('whisperx_environment', False, 'Environment check exceeded 20 seconds. Run Check environment in WhisperX before starting.')
    data = await storyboard.read_document(ctx['video_id']) if stage in {'image_prompts', 'video_prompts', 'images', 'videos', 'assembly'} else None
    direct_jobs = body.get('direct_jobs') if stage in {'images', 'videos'} else None
    if direct_jobs is not None:
        try:
            batch = desktop.Batch.model_validate({'jobs': direct_jobs})
            expected = 'image' if stage == 'images' else 'video'
            db = await get_db()
            for job in batch.jobs:
                if job.project_id != ctx['project_id'] or (job.video_id and job.video_id != ctx['video_id']) or job.kind != expected:
                    raise ValueError('Every media request must match the selected project, video and media type.')
                for key, sql in [('scene_id', 'SELECT video_id FROM scene WHERE id=?'),
                                 ('document_id', 'SELECT video_id FROM script_document WHERE id=?'),
                                 ('segment_id', 'SELECT d.video_id FROM script_segment s JOIN script_document d ON d.id=s.document_id WHERE s.id=?')]:
                    if getattr(job, key):
                        row = await (await db.execute(sql, (getattr(job, key),))).fetchone()
                        if not row or row[0] != ctx['video_id']:
                            raise ValueError('A media input belongs to another video.')
                if not job.prompt.strip():
                    raise ValueError('Every media request needs a non-empty prompt.')
            add('direct_jobs', True, f'{len(batch.jobs)} media requests have valid text and ownership.')
        except ValueError as error:
            add('direct_jobs', False, str(error))
    if stage in {'image_prompts', 'video_prompts', 'images', 'videos'} and direct_jobs is None:
        requested = set(body.get('segment_ids') or [])
        segments = data['segments']
        if requested:
            add('scene_scope', requested.issubset({s['id'] for s in segments}), 'All selected scenes must belong to the current video.')
            segments = [s for s in segments if s['id'] in requested]
        add('scenes', bool(segments), 'Import SRT scenes into this video before generating prompts or media.')
        if stage in {'images', 'videos'}:
            field = 'image_ready' if stage == 'images' else 'video_ready'
            eligible = [s for s in segments if s[field]]
            add('prompts', bool(eligible) and (not requested or len(eligible) == len(segments)),
                f'{len(eligible)} / {len(segments)} scenes have a current ' + ('image' if stage == 'images' else 'video') + ' prompt. Select ready scenes or create missing prompts first.')
            if not requested and eligible and len(eligible) != len(segments):
                add('partial_selection', False, 'Only scenes with a current prompt can be submitted. Review the selected rows before generating.', warn=True)
    if stage == 'assembly':
        if body.get('plan'):
            from agent.api.assembly import Plan
            try:
                plan = Plan.model_validate({**body['plan'], **ctx}).model_dump(mode='json')
                ids = [plan['audio_id'], plan['srt_id'], *plan['image_ids'], *plan['video_ids']]
                scope.resolve(ctx, [scope.ref('asset', aid) for aid in ids])
                report = assembly.plan(plan)
                add('scene_mapping', all(scene['asset_id'] for scene in report['scenes']), 'Every SRT scene must have a selected image or video.')
                for aid in dict.fromkeys(ids):
                    asset = assembly.asset(aid)
                    add('assembly_file_' + aid, file_ready(assembly.path(asset)), 'Saved input: ' + asset['title'])
                add('full_decode', False, 'Run Check files & preview for stream checks. Rendering performs full decoding.', warn=True)
            except (ValueError, KeyError, OSError) as error:
                add('assembly_plan', False, str(error))
        else:
            assets = [r for r in owned if r['resource_kind'] == 'asset' and resource_available(r)]
            for kind in ['audio', 'srt']:
                # Stage handoff can import approved sources without regenerating them.
                alternate = {'audio': {'elevenlabs', 'audio'}, 'srt': {'srt'}}[kind]
                available = any(r['asset_type'] == kind for r in assets) or any(r['resource_kind'] in alternate and resource_available(r) for r in owned)
                add(kind + '_source', available, 'Choose and load the matching ' + kind.upper() + ' source in Merge Video.')
            generated = any(j['current'] and j['state'] == 'COMPLETED' and any(file_ready(f) for f in j['files']) for s in data['segments'] for j in s['media_jobs'])
            add('visuals', generated or any(r['asset_type'] in {'image', 'video'} for r in assets), 'Load images or video clips and map every SRT scene before rendering.')
            add('assembly_plan', False, 'Select the exact audio, SRT and scene mapping, then run Check files & preview. This overview does not verify an unselected render plan.', warn=True)
    output = {'elevenlabs': el.output, 'whisperx': wx.output, 'srt': sub.output, 'assembly': assembly.output}.get(stage, desktop.ROOT)
    checks.extend(storage_checks(output))
    return {**ctx, 'protocol': 1, 'stage': stage, 'manual_stages': True,
            'blocked': any(c['status'] == 'fail' for c in checks), 'checks': checks}
