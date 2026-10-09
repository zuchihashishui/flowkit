"""Copy completed storyboard media into immutable, project-scoped assembly inputs."""
import json
from pathlib import Path
from agent.services.assembly_service import cues_from_srt
from agent.services import workflow_scope as scope


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
                    if previous is None and (not path.is_relative_to(desktop.ROOT.resolve()) or not path.is_file()):
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
