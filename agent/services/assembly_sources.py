"""Copy completed storyboard media into immutable, project-scoped assembly inputs."""
from agent.services import output_paths

import json
import asyncio
import hashlib
import io
from pathlib import Path
from agent.services.assembly_service import cues_from_srt
from agent.services import workflow_scope as scope

_load_lock = asyncio.Lock()


async def load_project_sources(service, ctx, visual_mode):
    """Load only this video's current inputs; repeated loads reuse frozen copies."""
    async with _load_lock:
        return await _load_project_sources(service, ctx, visual_mode)


async def _load_project_sources(service, ctx, visual_mode):
    from agent.api import storyboard
    from agent.services import video_files
    paths = await video_files.folders(**ctx)
    data = await storyboard.read_document(ctx['video_id'])
    doc, segments = data['document'], data['segments']
    owned = scope.select(scope.annotate(service, 'asset', service.assets()), **ctx)
    catalog = scope.select(scope.catalog(), **ctx)
    lookup = {(r['resource_kind'], r['id']): r for r in catalog}
    issues, subtitle, audio = [], None, None

    async def freeze(kind, name, *, path=None, raw=None, parents=()):
        if path is not None:
            path = Path(path)
            stat = path.stat()
            identity = f'{path.resolve()}:{stat.st_size}:{stat.st_mtime_ns}'
        else:
            identity = hashlib.sha256(raw).hexdigest()
        key = hashlib.sha256((kind + ':' + identity + ':' + json.dumps(list(parents), sort_keys=True)).encode()).hexdigest()
        previous = next((a for a in owned if a['metadata'].get('project_source_key') == key and service.path(a).is_file()), None)
        if previous:
            return previous
        scope.resolve(ctx, parents)
        class Reader:
            filename = name
            async def read(self, n):
                return stream.read(n)
        with (path.open('rb') if path is not None else io.BytesIO(raw)) as stream:
            result = await service.import_upload(kind, Reader(), ctx, parents,
                metadata_extra={'project_source_key': key})
        owned.append(result)
        return result

    # Scene Board is authoritative even when its SRT was imported directly,
    # without going through the JSON -> SRT job queue.
    source = (doc or {}).get('source') or {}
    origin = lookup.get((source.get('kind'), source.get('source_id')))
    if segments:
        content = '\n'.join(f"{s['ordinal']}\n{video_files.stamp(s['start_ms'])} --> {video_files.stamp(s['end_ms'])}\n{s['text']}\n" for s in segments)
        parents = [scope.ref(origin['resource_kind'], origin['id'])] if origin else []
        subtitle = await freeze('srt', 'scenes.srt', raw=content.encode('utf-8'), parents=parents)
    else:
        from agent.api.srt import service as srt
        for item in catalog:
            if item['resource_kind'] == 'srt' and item['state'] == 'COMPLETED':
                try:
                    subtitle = await freeze('srt', (item['title'] or 'scenes') + '.srt', path=srt.result_path(item['id'], require_approved=True), parents=[scope.ref('srt', item['id'])])
                    origin = item
                    break
                except (ValueError, OSError) as error:
                    issues.append('SRT: ' + str(error))
            elif item['resource_kind'] == 'asset' and item['asset_type'] == 'srt':
                candidate = service.asset(item['id'])
                if not candidate['metadata'].get('project_source_key') and service.path(candidate).is_file():
                    subtitle, origin = candidate, item
                    break

    has_elevenlabs = any(r['resource_kind'] == 'elevenlabs' and r['result_available'] for r in catalog)
    if not has_elevenlabs and doc and doc.get('audio_path'):
        path = Path(doc['audio_path'])
        if output_paths.allowed(path, storyboard.AUDIO_DIR):
            try:
                audio = await freeze('audio', doc.get('audio_name') or path.name, path=path)
            except (ValueError, OSError) as error:
                issues.append('Scene Board audio: ' + str(error))

    # Prefer the narration which produced this SRT. If provenance is external,
    # use the newest saved narration belonging to this exact video.
    linked, seen = [], set()
    def ancestors(item):
        if not item or (item['resource_kind'], item['id']) in seen:
            return
        seen.add((item['resource_kind'], item['id']))
        if item['resource_kind'] in ('audio', 'elevenlabs') or item['asset_type'] == 'audio':
            linked.append(item)
        for parent in item['sources']:
            ancestors(lookup.get((parent['kind'], parent['id'])))
    ancestors(origin)
    candidates = linked + [r for r in catalog if r not in linked and
        (r['resource_kind'] in ('audio', 'elevenlabs') or r['asset_type'] == 'audio')]
    if has_elevenlabs:
        candidates = [r for r in candidates if r['resource_kind'] == 'elevenlabs' and r['result_available']]
    from agent.api.whisperx import service as wx
    for item in candidates if audio is None else []:
        try:
            if item['resource_kind'] == 'elevenlabs':
                audio = await service.use_elevenlabs(item['id'], ctx)
            elif item['resource_kind'] == 'asset':
                candidate = service.asset(item['id'], 'audio')
                if candidate['metadata'].get('project_source_key') or not service.path(candidate).is_file():
                    continue
                audio = candidate
            else:
                if item['resource_kind'] == 'elevenlabs' and not item['result_available']:
                    continue
                _, path = wx.resolve_source(item['id'])
                audio = await freeze('audio', (item['title'] or 'narration') + path.suffix, path=path,
                    parents=[scope.ref(item['resource_kind'], item['id'])])
            break
        except (ValueError, OSError) as error:
            issues.append('Audio: ' + str(error))

    media = {'assets': [], 'mapping': {}, 'issues': []}
    if subtitle and segments:
        media = await load_scene_media(service, ctx, subtitle['id'], visual_mode)
    else:
        media['assets'] = [a for a in owned if a['kind'] in (['image'] if visual_mode == 'images' else ['image', 'video'])
            and not a['metadata'].get('media_job_id') and service.path(a).is_file()]
    if subtitle is None:
        issues.append('No SRT saved for this video. Import its SRT or finish JSON -> SRT.')
    if audio is None:
        issues.append('No narration saved for this video. Import its audio or finish ElevenLabs.')
    return {'project_id': ctx['project_id'], 'video_id': ctx['video_id'], 'title': data['video']['title'],
        'srt_id': subtitle['id'] if subtitle else None, 'audio_id': audio['id'] if audio else None,
        'assets': media['assets'], 'mapping': media['mapping'], 'issues': issues + media['issues'],
        'output_directory': paths['folders']['exports'],
        'visual_mode': 'mixed' if any(a['kind'] == 'video' for a in media['assets']) else 'images'}


async def load_scene_media(service, ctx, srt_id, visual_mode):
    from agent.api import storyboard, desktop
    if not ctx.get('video_id'):
        raise ValueError('Select a project first.')
    data = await storyboard.read_document(ctx['video_id'])
    subtitle = service.asset(srt_id, 'srt')
    _, cues = cues_from_srt(service.path(subtitle).read_bytes())
    segments = data['segments']
    if len(cues) != len(segments) or any(
        abs(c['start']*1000-s['start_ms']) > 1 or abs(c['end']*1000-s['end_ms']) > 1
        or ''.join(c['text'].split()) != ''.join(s['text'].split()) for c, s in zip(cues, segments)):
        raise ValueError('The selected SRT does not match this project’s current scenes. Choose the SRT used to create these scenes.')
    jobs = desktop.rows()
    copied = scope.select(scope.annotate(service, 'asset', service.assets()), **ctx)
    results, mapping, issues = [], {}, []
    for cue, segment in zip(cues, segments):
        candidates = []
        for kind in (['image'] if visual_mode == 'images' else ['video', 'image']):
            matching = []
            for job in jobs:
                p = json.loads(job['payload'])
                if (job['state'] == 'COMPLETED' and p.get('project_id') == ctx['project_id']
                    and p.get('document_id') == data['document']['id'] and p.get('segment_id') == segment['id']
                    and storyboard.media_is_current(data['video'], data['document'], segment, p) and p['kind'] == kind
                    and p.get('start_ms') == segment['start_ms'] and p.get('end_ms') == segment['end_ms']):
                    matching.append(job)
            if not segment['ready']:
                continue
            for job in matching:
                for index, filename in enumerate(json.loads(job['files'])):
                    previous = next((a for a in copied if a['metadata'].get('media_job_id') == job['id'] and a['metadata'].get('file_index') == index and service.path(a).is_file()), None)
                    path = Path(filename).resolve()
                    if previous is None and (not output_paths.allowed(path, desktop.ROOT) or not path.is_file()):
                        issues.append(f"Scene {cue['index']}: a saved {kind} file is missing.")
                        continue
                    try:
                        if previous is None:
                            class Reader:
                                filename = f"{cue['index']:03d}-{job['id'][:8]}-{index+1}{path.suffix}"
                                async def read(self, n):
                                    return stream.read(n)
                            with path.open('rb') as stream:
                                previous = await service.import_upload(kind, Reader(), ctx, [scope.ref('asset', srt_id)], metadata_extra={
                                    'media_job_id':job['id'], 'file_index':index, 'segment_id':segment['id'],
                                    'concept_id':json.loads(job['payload']).get('concept_id'), 'ordinal':cue['index']})
                            copied.append(previous)
                        results.append(previous)
                        candidates.append(previous)
                    except (ValueError, OSError) as error:
                        issues.append(f"Scene {cue['index']}: {error}")
        mapping[str(cue['index'])] = candidates[0]['id'] if candidates else None
        if not candidates:
            issues.append(f"Scene {cue['index']}: no saved media for the current concept and timing.")
    return {'assets':list({a['id']:a for a in results}.values()), 'mapping':mapping, 'issues':issues}
