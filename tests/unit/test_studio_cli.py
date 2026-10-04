"""The production CLI must checkpoint submissions and reuse provider results."""
from copy import deepcopy
import json
from pathlib import Path
import time
from uuid import UUID

import httpx
import pytest

from agent.studio_cli import Backend, Runner, StopRun, checkpoint_lock, digest, manifest_config


PID = '11111111-1111-4111-8111-111111111111'
VID = '22222222-2222-4222-8222-222222222222'


def uid(number):
    return str(UUID(int=number))


class Studio:
    def __init__(self):
        self.calls = []
        self.counter = 10
        self.resources = []
        self.audio = {}
        self.wx = {}
        self.srt = {}
        self.assembly = {}
        self.doc = {'video': {'id': VID, 'project_id': PID}, 'document': None, 'segments': []}
        self.media_jobs = []
        self.assets = []
        self.quality = {'status': 'PASSED', 'approved': False}
        self.blocked = False
        self.lose_audio_response = False
        self.audio_state = 'COMPLETED'
        self.settings = {'project_id': PID, 'video_id': VID, 'revision': 0, 'project_revision': 1,
            'effective': {'tts': {'model': 'Eleven v4', 'max_chunk_characters': 3000},
                'whisperx': {'device': 'cuda', 'model': 'large-v3', 'language': 'ja', 'video_duration_seconds': 100},
                'media': {'orientation': 'HORIZONTAL', 'image_model': None},
                'assembly': {'image_motion': 'none', 'fps': 30, 'size': '720p'},
                'srt': {'instructions': 'Preserve source timestamps.'}}}
        self.api = Backend(client=httpx.Client(transport=httpx.MockTransport(self.handle)))

    def resource(self, kind, sources=(), **extra):
        self.counter += 1
        item = {'resource_kind': kind, 'id': uid(self.counter), 'project_id': PID, 'video_id': VID,
                'created': time.time(), 'sources': list(sources), **extra}
        self.resources.append(item)
        return item['id']

    def handle(self, request):
        path, method = request.url.path, request.method
        body = json.loads(request.content) if request.content and request.headers.get('content-type') == 'application/json' else None
        self.calls.append((method, path, body))
        def ok(data):
            return httpx.Response(200, json=deepcopy(data))
        if method == 'GET' and path == f'/api/videos/{VID}/settings':
            return ok(self.settings)
        if path == '/api/production/preflight':
            return ok({'blocked': self.blocked, 'checks': [{'status': 'fail', 'message': 'Extension disconnected'}] if self.blocked else []})
        if path == '/api/workflow/resources':
            return ok({'resources': self.resources})
        if method == 'POST' and path == '/api/elevenlabs/jobs':
            jid = self.resource('elevenlabs')
            self.audio[jid] = {'id': jid, 'state': self.audio_state, 'merged_url': f'/api/elevenlabs/audio/{jid}/merged', 'completed_chunks': 1}
            if self.lose_audio_response:
                self.lose_audio_response = False
                raise httpx.ReadError('response lost', request=request)
            return ok(self.audio[jid])
        if method == 'GET' and path.startswith('/api/elevenlabs/jobs/'):
            return ok(self.audio[path.rsplit('/', 1)[1]])
        if method == 'POST' and path == '/api/whisperx/import':
            return ok({'id': self.resource('audio')})
        if method == 'POST' and path == '/api/whisperx/jobs':
            kind = next(r['resource_kind'] for r in self.resources if r['id'] == body['source_id'])
            jid = self.resource('whisperx', [{'kind': kind, 'id': body['source_id']}])
            self.wx[jid] = {'id': jid, 'state': 'COMPLETED', 'source_id': body['source_id'], 'split_available': True}
            return ok(self.wx[jid])
        if path == '/api/whisperx/status':
            return ok({'jobs': list(self.wx.values())})
        if method == 'POST' and path == '/api/srt/jobs':
            # Real backend copies a WhisperX transcript into a JSON resource first.
            source = self.resource('json', [{'kind': 'whisperx', 'id': body['source_id']}])
            jid = self.resource('srt', [{'kind': 'json', 'id': source}])
            self.srt[jid] = {'id': jid, 'source_id': source, 'state': 'COMPLETED'}
            return ok({'id': jid})
        if path == '/api/srt/status':
            return ok({'jobs': list(self.srt.values())})
        if path.startswith('/api/srt/jobs/') and path.endswith('/quality'):
            return ok(self.quality)
        if method == 'POST' and path == '/api/workflow/import-scenes':
            self.doc['document'] = {'id': uid(5), 'revision': 1, 'source': {'kind': 'srt', 'source_id': body['id']}}
            self.doc['segments'] = [{'id': uid(i), 'ordinal': i - 5, 'revision': 1, 'start_ms': (i - 6) * 10000,
                'end_ms': (i - 5) * 10000, 'text': f'場面{i}', 'job': None, 'media_jobs': [], 'image_ready': False, 'video_ready': False} for i in (6, 7)]
            return ok(self.doc)
        if method == 'GET' and path == f'/api/storyboard/videos/{VID}':
            return ok(self.doc)
        if method == 'POST' and path.endswith('/generate-concepts'):
            ids = []
            for segment in self.doc['segments']:
                if segment['id'] not in body['segment_ids']:
                    continue
                self.counter += 1
                jid = uid(self.counter)
                ids.append(jid)
                segment['job'] = {'id': jid, 'state': 'COMPLETED'}
                kind = body['prompt_kind']
                segment[kind + '_ready'] = True
                segment.setdefault('active_concept', {'id': uid(self.counter + 100), 'image_prompt': '', 'video_prompt': ''})[kind + '_prompt'] = kind + ':' + segment['text']
            return ok({'ids': ids, 'skipped': []})
        if method == 'POST' and path.endswith('/generate-media'):
            ids = []
            for segment in self.doc['segments']:
                if segment['id'] not in body['segment_ids']:
                    continue
                self.counter += 1
                jid = uid(self.counter)
                ids.append(jid)
                payload = {'video_id': VID, 'segment_id': segment['id'], 'kind': body['kind']}
                segment['media_jobs'].append({'id': jid, 'state': 'COMPLETED', 'current': True, 'kind': body['kind'], 'files': ['saved.png']})
                self.media_jobs.append({'id': jid, 'payload': payload})
            return ok({'ids': ids, 'skipped': []})
        if path == '/api/desktop/jobs':
            return ok({'jobs': self.media_jobs})
        if method == 'POST' and path == '/api/assembly/source':
            parent_kind = 'srt' if body['kind'] == 'srt' else next(r['resource_kind'] for r in self.resources if r['id'] == body['source_id'])
            aid = self.resource('asset', [{'kind': parent_kind, 'id': body['source_id']}])
            return ok({'id': aid, 'kind': body['kind']})
        if method == 'POST' and path == '/api/assembly/scene-media':
            assets, mapping = [], {}
            for segment in self.doc['segments']:
                for job in segment['media_jobs']:
                    aid = self.resource('asset')
                    assets.append({'id': aid, 'kind': job['kind'], 'metadata': {'segment_id': segment['id'], 'media_job_id': job['id']}})
                    mapping[str(segment['ordinal'])] = aid
            self.assets = assets
            return ok({'assets': assets, 'mapping': mapping, 'issues': []})
        if method == 'POST' and path == '/api/assembly/jobs':
            jid = self.resource('assembly')
            self.assembly[jid] = {'id': jid, 'state': 'COMPLETED'}
            return ok({'id': jid})
        if path == '/api/assembly/status':
            return ok({'jobs': list(self.assembly.values())})
        if method == 'GET' and any(part in path for part in ['/result', '/merged', '/video']):
            return httpx.Response(200, content=b'fixture artifact bytes')
        raise AssertionError((method, path, body))


@pytest.fixture
def project(tmp_path):
    (tmp_path / 'script.txt').write_text('日本語の長いナレーション。\n二番目の文章。', encoding='utf-8')
    path = tmp_path / 'pipeline.json'
    path.write_text(json.dumps({'project_id': PID, 'video_id': VID, 'narration_file': 'script.txt'}), encoding='utf-8')
    return path


def runner(studio, project, tmp_path):
    return Runner.create(studio.api, project, tmp_path / 'run' / 'run.json', emit=lambda text: None, poll=.001)


def posts(studio, suffix):
    return [body for method, path, body in studio.calls if method == 'POST' and path.endswith(suffix)]


def test_complete_image_pipeline_batches_once_and_exports_all_artifacts(project, tmp_path):
    studio = Studio()
    run = runner(studio, project, tmp_path)
    run.run(continuous=True)
    assert run.data['state'] == 'COMPLETED'
    assert set(run.data['stages']) == {'audio', 'whisperx', 'srt', 'scenes', 'image_prompts', 'images', 'assembly'}
    assert len(posts(studio, '/generate-concepts')) == len(posts(studio, '/generate-media')) == 1
    assert len(posts(studio, '/generate-media')[0]['segment_ids']) == 2
    assert posts(studio, '/generate-concepts')[0]['prompt_kind'] == 'image'
    assert posts(studio, '/whisperx/jobs')[0]['device'] == 'cuda'
    assert posts(studio, '/assembly/jobs')[0]['image_motion'] == 'none'
    assert set(run.data['artifacts']) == {'merged.mp3', 'transcript.json', 'transcript_video.json', 'transcript_image.json', 'subtitles.srt', 'video.mp4'}
    assert all(Path(a['path']).is_file() for a in run.data['artifacts'].values())
    before = len(studio.calls)
    Runner.load(studio.api, run.path, emit=lambda text: None).run(continuous=True)
    assert len(studio.calls) == before


def test_default_pauses_and_resume_does_not_repeat_audio(project, tmp_path):
    studio = Studio()
    run = runner(studio, project, tmp_path)
    run.run()
    assert set(run.data['stages']) == {'audio'}
    assert run.data['state'] == 'PAUSED'
    Runner.load(studio.api, run.path, emit=lambda text: None).run()
    assert len(posts(studio, '/elevenlabs/jobs')) == 1
    assert len(posts(studio, '/whisperx/jobs')) == 1
    assert not posts(studio, '/srt/jobs')


def test_lost_submit_response_requires_reconciliation_and_never_resends(project, tmp_path):
    studio = Studio()
    studio.lose_audio_response = True
    run = runner(studio, project, tmp_path)
    with pytest.raises(StopRun, match='Cannot reach Studio'):
        run.run()
    assert run.data['operations']['audio.submit']['state'] == 'UNCERTAIN'
    resumed = Runner.load(studio.api, run.path, emit=lambda text: None)
    with pytest.raises(StopRun, match='Unresolved submission'):
        resumed.run()
    assert len(posts(studio, '/elevenlabs/jobs')) == 1
    jid = next(iter(studio.audio))
    resumed.reconcile('audio.submit', response={'id': jid}, reviewed=True)
    resumed.run()
    assert len(posts(studio, '/elevenlabs/jobs')) == 1
    assert resumed.result('audio')['id'] == jid


def test_checkpoint_is_saved_before_http_submission(project, tmp_path):
    studio = Studio()
    run = runner(studio, project, tmp_path)
    original = studio.api.request
    def inspect(method, path, body=None, **kwargs):
        if path == '/api/elevenlabs/jobs':
            checkpoint = json.loads(run.path.read_text())
            assert checkpoint['operations']['audio.submit']['state'] == 'SUBMITTING'
            assert checkpoint['operations']['audio.submit']['request']['body']['text'] == run.config['narration_text']
        return original(method, path, body, **kwargs)
    studio.api.request = inspect
    run.run()


def test_preflight_blocks_paid_submission(project, tmp_path):
    studio = Studio()
    studio.blocked = True
    run = runner(studio, project, tmp_path)
    with pytest.raises(StopRun, match='preflight blocked'):
        run.run()
    assert not posts(studio, '/elevenlabs/jobs')
    studio.blocked = False
    run.run()
    assert len(posts(studio, '/elevenlabs/jobs')) == 1


def test_srt_quality_requires_manual_approval_even_continuous(project, tmp_path):
    studio = Studio()
    studio.quality = {'status': 'REVIEW', 'approved': False, 'issues': [{'message': 'Short final cue'}]}
    run = runner(studio, project, tmp_path)
    with pytest.raises(StopRun, match='human review'):
        run.run(continuous=True)
    assert not posts(studio, '/workflow/import-scenes')
    assert (run.path.parent / 'srt-quality.json').is_file()
    studio.quality['approved'] = True
    run.run(continuous=True)
    assert len(posts(studio, '/srt/jobs')) == 1
    assert run.data['state'] == 'COMPLETED'


def test_mixed_pipeline_targets_selected_scene_and_zoom_images_only(project, tmp_path):
    cfg = json.loads(project.read_text())
    cfg.update(media={'visual_mode': 'mixed', 'video_scene_ordinals': [1]}, assembly={'image_motion': 'zoom_out'})
    project.write_text(json.dumps(cfg))
    studio = Studio()
    run = runner(studio, project, tmp_path)
    run.run(continuous=True)
    prompts = posts(studio, '/generate-concepts')
    assert [(p['prompt_kind'], p['segment_ids']) for p in prompts] == [('image', [uid(7)]), ('video', [uid(6)])]
    media = posts(studio, '/generate-media')
    assert [(p['kind'], p['segment_ids']) for p in media] == [('image', [uid(7)]), ('video', [uid(6)])]
    assert media[1]['duration_mode'] == 'srt'
    plan = posts(studio, '/assembly/jobs')[0]
    assert plan['image_motion'] == 'zoom_out'
    by_id = {a['id']: a for a in studio.assets}
    assert by_id[plan['mapping']['1']]['kind'] == 'video'
    assert by_id[plan['mapping']['2']]['kind'] == 'image'


def test_existing_audio_upload_is_checkpointed_and_no_tts(project, tmp_path):
    cfg = json.loads(project.read_text())
    cfg.pop('narration_file')
    cfg['audio_file'] = 'merged.mp3'
    project.write_text(json.dumps(cfg))
    (tmp_path / 'merged.mp3').write_bytes(b'audio')
    studio = Studio()
    run = runner(studio, project, tmp_path)
    run.run()
    assert run.result('audio')['kind'] == 'audio'
    assert not posts(studio, '/elevenlabs/jobs')
    assert len(posts(studio, '/whisperx/import')) == 1


def test_changed_audio_file_is_rejected_before_upload(project, tmp_path):
    cfg = json.loads(project.read_text())
    cfg.pop('narration_file')
    cfg['audio_file'] = 'merged.mp3'
    project.write_text(json.dumps(cfg))
    source = tmp_path / 'merged.mp3'
    source.write_bytes(b'audio')
    studio = Studio()
    run = runner(studio, project, tmp_path)
    source.write_bytes(b'changed audio')
    with pytest.raises(StopRun, match='changed or moved'):
        run.run()
    assert not posts(studio, '/whisperx/import')


def test_scene_edit_stops_remaining_stages(project, tmp_path):
    studio = Studio()
    run = runner(studio, project, tmp_path)
    run.run(continuous=True, until='scenes')
    studio.doc['segments'][0]['text'] = 'Changed script'
    with pytest.raises(StopRun, match='Scene text'):
        run.run(continuous=True)
    assert not posts(studio, '/generate-concepts')


def test_prompt_edit_stops_media_generation(project, tmp_path):
    studio = Studio()
    run = runner(studio, project, tmp_path)
    run.run(continuous=True, until='image_prompts')
    studio.doc['segments'][0]['active_concept']['image_prompt'] = 'Different prompt'
    with pytest.raises(StopRun, match='saved prompt changed'):
        run.run(continuous=True)
    assert not posts(studio, '/generate-media')


def test_failed_scene_is_not_automatically_regenerated(project, tmp_path):
    studio = Studio()
    run = runner(studio, project, tmp_path)
    run.run(continuous=True, until='scenes')
    studio.doc['segments'][0]['job'] = {'id': uid(900), 'state': 'NEEDS_REVIEW'}
    with pytest.raises(StopRun, match='need review'):
        run.run(continuous=True)
    assert not posts(studio, '/generate-concepts')


def test_wait_timeout_resume_polls_same_job(project, tmp_path):
    studio = Studio()
    studio.audio_state = 'RUNNING'
    run = runner(studio, project, tmp_path)
    run.wait_timeout = .001
    with pytest.raises(StopRun, match='waiting time reached'):
        run.run()
    jid = next(iter(studio.audio))
    studio.audio[jid]['state'] = 'COMPLETED'
    run.wait_timeout = 10
    run.run()
    assert len(posts(studio, '/elevenlabs/jobs')) == 1


def test_config_digest_prevents_modified_checkpoint(project, tmp_path):
    studio = Studio()
    run = runner(studio, project, tmp_path)
    payload = json.loads(run.path.read_text())
    payload['config']['video_id'] = uid(999)
    run.path.write_text(json.dumps(payload))
    with pytest.raises(StopRun, match='digest'):
        Runner.load(studio.api, run.path)


def test_lock_prevents_two_processes_using_checkpoint(tmp_path):
    path = tmp_path / 'run.json'
    with checkpoint_lock(path):
        with pytest.raises(StopRun, match='Another CLI process'):
            with checkpoint_lock(path):
                pytest.fail('Second lock should fail')
    with checkpoint_lock(path):
        pass


@pytest.mark.parametrize('url', ['https://example.com', 'http://127.0.0.1:8100@evil.com', 'http://127.0.0.1:8100/path', 'http://127.0.0.1:8100?query=x'])
def test_only_local_backend_is_allowed(url):
    with pytest.raises(StopRun):
        Backend(url)


def test_manifest_rejects_unknown_fields(project):
    cfg = json.loads(project.read_text())
    cfg['media'] = {'orientatoin': 'VERTICAL'}
    project.write_text(json.dumps(cfg))
    with pytest.raises(StopRun, match='Unknown media options'):
        manifest_config(project)


def test_wrong_recovered_job_cannot_cross_video(project, tmp_path):
    studio = Studio()
    studio.lose_audio_response = True
    run = runner(studio, project, tmp_path)
    with pytest.raises(StopRun):
        run.run()
    with pytest.raises(StopRun, match='missing or does not belong'):
        run.reconcile('audio.submit', response={'id': uid(999)}, reviewed=True)
    assert run.data['operations']['audio.submit']['state'] == 'UNCERTAIN'


def test_invalid_option_fails_before_any_paid_job(project, tmp_path):
    cfg = json.loads(project.read_text())
    cfg['assembly'] = {'image_motion': 'sideways'}
    project.write_text(json.dumps(cfg))
    studio = Studio()
    with pytest.raises(StopRun, match='Invalid assembly.image_motion'):
        runner(studio, project, tmp_path)
    assert not posts(studio, '/elevenlabs/jobs')


def test_incomplete_success_response_requires_review_not_resend(project, tmp_path):
    studio = Studio()
    run = runner(studio, project, tmp_path)
    original = studio.api.request
    def incomplete(method, path, body=None, **kwargs):
        response = original(method, path, body, **kwargs)
        return {} if path == '/api/elevenlabs/jobs' else response
    studio.api.request = incomplete
    with pytest.raises(StopRun, match='response was incomplete'):
        run.run()
    assert run.data['operations']['audio.submit']['state'] == 'UNCERTAIN'
    with pytest.raises(StopRun, match='Unresolved submission'):
        run.run()
    assert len(posts(studio, '/elevenlabs/jobs')) == 1


def test_cpu_override_is_forwarded_to_preflight_not_replaced_by_gpu_default(project, tmp_path):
    cfg = json.loads(project.read_text())
    cfg['whisperx'] = {'device': 'cpu'}
    project.write_text(json.dumps(cfg))
    studio = Studio()
    run = runner(studio, project, tmp_path)
    run.run(continuous=True, until='whisperx')
    checks = [body for body in posts(studio, '/production/preflight') if body['stage'] == 'whisperx']
    assert checks[0]['device'] == 'cpu'
    assert posts(studio, '/whisperx/jobs')[0]['device'] == 'cpu'
