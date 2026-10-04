"""Shared-backend, checkpointed production CLI. No browser automation lives here."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from copy import deepcopy
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import time
from urllib.parse import urlencode, urlsplit
from uuid import UUID, uuid4

import httpx


SCHEMA = 1
TERMINAL_ERRORS = {'FAILED', 'CANCELLED', 'NEEDS_REVIEW', 'INTERRUPTED', 'STALE'}
STAGES = ('audio', 'whisperx', 'srt', 'scenes', 'image_prompts', 'video_prompts', 'images', 'videos', 'assembly')
DEFAULT_SRT_PROMPT = """Use the attached WhisperX JSON to create scene subtitles in the original language.
Preserve all transcript text and real word timestamps. Each scene should express a complete thought,
usually 3–15 seconds. Start at zero, join neighboring scene boundaries, and end at the actual audio
length. Never invent timing or missing speech. Follow the supplied JSON boundary protocol exactly.
Report any unavoidable duration or alignment exceptions outside the result. Return the requested
machine-readable scene boundaries without commentary inside the result."""


class StopRun(Exception):
    """An actionable, resumable stop; never implies cancellation of remote work."""


class APIError(StopRun):
    def __init__(self, status, message):
        self.status = status
        super().__init__(f'Backend HTTP {status}: {message}')


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def file_digest(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def atomic_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=path.name + '.', suffix='.part', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


@contextmanager
def checkpoint_lock(path):
    """OS locks are released on process death; a stale lock file is harmless."""
    path = Path(str(path) + '.lock')
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a+b') as stream:
        stream.seek(0)
        if not stream.read(1):
            stream.write(b'0')
            stream.flush()
        stream.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise StopRun('Another CLI process is using this checkpoint. Wait for it to finish.') from exc
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == 'nt':
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


class Backend:
    def __init__(self, base_url='http://127.0.0.1:8100', *, client=None):
        parsed = urlsplit(base_url)
        if parsed.scheme not in {'http', 'https'} or parsed.hostname not in {'localhost', '127.0.0.1', '::1'} or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {'', '/'}:
            raise StopRun('Use the local Studio backend URL, for example http://127.0.0.1:8100.')
        self.base_url = base_url.rstrip('/')
        self.client = client or httpx.Client(timeout=60, follow_redirects=False, trust_env=False)

    def request(self, method, path, body=None, *, upload=None):
        if not path.startswith('/api/') or path.startswith('//'):
            raise StopRun('Only local /api/ backend routes are supported.')
        try:
            if upload:
                with Path(upload).open('rb') as stream:
                    response = self.client.request(method, self.base_url + path, data=body,
                        files={'file': (Path(upload).name, stream)}, timeout=300)
            else:
                response = self.client.request(method, self.base_url + path, json=body)
        except httpx.HTTPError as exc:
            raise StopRun(f'Cannot reach Studio: {exc}. Start the updated backend and resume the same checkpoint.') from exc
        if not response.is_success:
            try:
                message = response.json().get('detail', response.text)
            except ValueError:
                message = response.text
            raise APIError(response.status_code, str(message)[:1800])
        try:
            return response.json()
        except ValueError as exc:
            raise StopRun('Backend returned a non-JSON response. Update and restart Studio.') from exc

    def download(self, path, target):
        if not path.startswith('/api/') or path.startswith('//'):
            raise StopRun('Unexpected artifact URL from the backend.')
        target = Path(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(target.name + '.part')
        try:
            with self.client.stream('GET', self.base_url + path, timeout=300) as response:
                if not response.is_success:
                    raise APIError(response.status_code, 'Artifact download failed; resume to download again.')
                with temporary.open('wb') as stream:
                    for block in response.iter_bytes(1024 * 1024):
                        stream.write(block)
                    stream.flush()
                    os.fsync(stream.fileno())
            os.replace(temporary, target)
        except httpx.HTTPError as exc:
            raise StopRun(f'Artifact download interrupted: {exc}. Resume the same checkpoint.') from exc
        finally:
            temporary.unlink(missing_ok=True)


def valid_id(value, label):
    try:
        return str(UUID(str(value)))
    except (ValueError, TypeError, AttributeError) as exc:
        raise StopRun(f'{label} must be an existing Studio UUID.') from exc


def manifest_config(path):
    path = Path(path).resolve()
    try:
        data = json.loads(path.read_text(encoding='utf-8-sig'))
    except (OSError, ValueError) as exc:
        raise StopRun(f'Cannot read manifest: {exc}') from exc
    if not isinstance(data, dict):
        raise StopRun('The manifest must be a JSON object.')
    allowed = {'project_id', 'video_id', 'title', 'narration_file', 'audio_file', 'audio_source', 'whisperx_id', 'srt_id',
               'srt_instructions_file', 'tts', 'whisperx', 'srt', 'media', 'assembly', 'output_dir'}
    if set(data) - allowed:
        raise StopRun('Unknown manifest fields: ' + ', '.join(sorted(set(data) - allowed)))
    data['project_id'] = valid_id(data.get('project_id'), 'project_id')
    data['video_id'] = valid_id(data.get('video_id'), 'video_id')
    if sum(bool(data.get(k)) for k in ('narration_file', 'audio_file', 'audio_source')) != 1:
        raise StopRun('Provide exactly one of narration_file, audio_file or audio_source.')
    if data.get('audio_source'):
        source = data['audio_source']
        if not isinstance(source, dict) or set(source) != {'kind', 'id'} or source['kind'] not in {'elevenlabs', 'audio'}:
            raise StopRun('audio_source needs kind (elevenlabs or audio) and id.')
        source['id'] = valid_id(source['id'], 'audio_source.id')
    for key in ('whisperx_id', 'srt_id'):
        if data.get(key):
            data[key] = valid_id(data[key], key)
    for key in ('tts', 'whisperx', 'srt', 'media', 'assembly'):
        if key in data and not isinstance(data[key], dict):
            raise StopRun(f'{key} must be an object.')
    option_fields = {
        'tts': {'model', 'max_chunk_characters'},
        'whisperx': {'model', 'device', 'language', 'batch_size', 'video_duration_seconds'},
        'srt': {'model', 'timeout', 'duration_seconds'},
        'media': {'orientation', 'image_model', 'visual_mode', 'video_scene_seconds', 'video_scene_ordinals', 'duration', 'duration_mode'},
        'assembly': {'size', 'fps', 'fit', 'image_motion', 'subtitles', 'font', 'clip_end'},
    }
    for group, names in option_fields.items():
        extra = set(data.get(group, {})) - names
        if extra:
            raise StopRun(f'Unknown {group} options: ' + ', '.join(sorted(extra)))
    for key in ('narration_file', 'srt_instructions_file', 'audio_file'):
        if data.get(key):
            source = (path.parent / data[key]).resolve()
            if not source.is_file():
                raise StopRun(f'{key} does not exist: {source}')
            data[key] = str(source)
            if key == 'audio_file':
                data['audio_file_sha256'] = file_digest(source)
            else:
                data['narration_text' if key == 'narration_file' else 'srt_instructions'] = source.read_text(encoding='utf-8-sig').strip()
    if data.get('narration_file') and not data.get('narration_text'):
        raise StopRun('The narration file is empty.')
    data['output_dir'] = str((path.parent / data.get('output_dir', 'output')).resolve())
    return data


def freeze_defaults(config, backend):
    config = deepcopy(config)
    settings = backend.request('GET', f"/api/videos/{config['video_id']}/settings")
    if settings.get('project_id') != config['project_id'] or not isinstance(settings.get('effective'), dict):
        raise StopRun('Video settings do not match the selected project. Update Studio and check the IDs.')
    defaults = settings['effective']
    groups = {
        'tts': ('model', 'max_chunk_characters'),
        'whisperx': ('model', 'device', 'language', 'batch_size', 'video_duration_seconds'),
        'media': ('orientation', 'image_model'),
        'assembly': ('size', 'fps', 'fit', 'subtitles', 'font', 'image_motion'),
    }
    for key, names in groups.items():
        config[key] = {**{k: v for k, v in defaults.get(key, {}).items() if k in names}, **config.get(key, {})}
    config['srt_instructions'] = config.get('srt_instructions') or defaults.get('srt', {}).get('instructions') or DEFAULT_SRT_PROMPT
    config['defaults_revision'] = {'project': settings.get('project_revision'), 'video': settings.get('revision')}
    media = config.setdefault('media', {})
    if media.setdefault('visual_mode', 'images') not in {'images', 'mixed'}:
        raise StopRun('media.visual_mode must be images or mixed.')
    if media.get('video_scene_ordinals') is not None and (not isinstance(media['video_scene_ordinals'], list) or any(type(i) is not int or i < 1 for i in media['video_scene_ordinals'])):
        raise StopRun('video_scene_ordinals must be a list of positive scene numbers.')
    if type(media.get('video_scene_seconds', 100)) not in {int, float} or not 0 <= media.get('video_scene_seconds', 100) <= 86400:
        raise StopRun('video_scene_seconds must be between 0 and 86400.')
    validate_options(config)
    return config


def validate_options(config):
    choices = {
        'whisperx': {'model': {'tiny','base','small','medium','large-v2','large-v3'}, 'device': {'auto','cpu','cuda'}},
        'media': {'orientation': {'HORIZONTAL','VERTICAL'}, 'duration_mode': {'manual','srt'}, 'duration': {4,6,8,10}},
        'assembly': {'size': {'1080p','720p','vertical'}, 'fps': {24,30,60}, 'fit': {'fit','crop'},
            'image_motion': {'none','zoom_in','zoom_out'}, 'subtitles': {'burn','soft','off'}, 'clip_end': {'freeze','loop'}},
    }
    for group, fields in choices.items():
        for name, allowed in fields.items():
            value = config.get(group, {}).get(name)
            if value is not None and (not isinstance(value, (str, int)) or isinstance(value, bool) or value not in allowed):
                raise StopRun(f'Invalid {group}.{name}: {value}. Allowed: {sorted(allowed)}')
    for group, field, minimum, maximum in [('tts','max_chunk_characters',100,3000), ('whisperx','batch_size',1,32), ('srt','timeout',60,1800)]:
        value = config.get(group, {}).get(field)
        if value is not None and (type(value) is not int or not minimum <= value <= maximum):
            raise StopRun(f'{group}.{field} must be an integer from {minimum} to {maximum}.')
    if len(config.get('narration_text', '')) > 500000:
        raise StopRun('Narration exceeds the 500,000-character backend limit.')
    if len(config.get('srt_instructions', '')) > 100000:
        raise StopRun('SRT instructions exceed the 100,000-character backend limit.')
    if config.get('title') is not None and (not isinstance(config['title'], str) or not 1 <= len(config['title']) <= 200):
        raise StopRun('Title must contain 1–200 characters.')


class Runner:
    def __init__(self, backend, path, data, *, poll=3, wait_timeout=3600, emit=print):
        self.api, self.path, self.data = backend, Path(path), data
        self.config = data['config']
        if data.get('schema') != SCHEMA or digest(self.config) != data.get('config_sha256'):
            raise StopRun('Checkpoint version or configuration digest is invalid. Restore the original checkpoint.')
        self.scope = {k: self.config[k] for k in ('project_id', 'video_id')}
        self.query = '?' + urlencode(self.scope)
        self.poll, self.wait_timeout, self.emit = max(0.01, poll), wait_timeout, emit
        self.deadline = None

    @classmethod
    def create(cls, backend, manifest, path=None, **kwargs):
        config = freeze_defaults(manifest_config(manifest), backend)
        run_id = str(uuid4())
        path = Path(path) if path else Path(config['output_dir']) / 'runs' / run_id / 'run.json'
        if path.exists():
            raise StopRun('Checkpoint already exists. Use --resume; do not overwrite a previous run.')
        data = {'schema': SCHEMA, 'id': run_id, 'created': time.time(), 'backend_url': backend.base_url,
                'config': config, 'config_sha256': digest(config), 'stages': {}, 'operations': {}, 'artifacts': {}, 'state': 'READY'}
        atomic_json(path, data)
        return cls(backend, path, data, **kwargs)

    @classmethod
    def load(cls, backend, path, **kwargs):
        try:
            data = json.loads(Path(path).read_text(encoding='utf-8'))
        except (OSError, ValueError) as exc:
            raise StopRun(f'Cannot load checkpoint: {exc}') from exc
        if data.get('backend_url') != backend.base_url:
            raise StopRun('Checkpoint belongs to a different backend URL. Use the original --backend URL.')
        return cls(backend, path, data, **kwargs)

    def save(self):
        self.data['updated'] = time.time()
        atomic_json(self.path, self.data)

    def read(self, path):
        return self.api.request('GET', path)

    def mutate(self, key, path, body, *, method='POST', upload=None):
        request = {'method': method, 'path': path, 'body': body, 'upload': upload}
        operations = self.data['operations']
        old = operations.get(key)
        if old:
            if digest(request) != old['request_sha256']:
                raise StopRun(f'Inputs changed for {key}. This run will not submit a different request under the same checkpoint.')
            if old['state'] == 'SAVED':
                return deepcopy(old['response'])
            if old['state'] != 'NOT_SUBMITTED':
                raise StopRun(f'{key} has an unresolved submission ({old["state"]}). Inspect Studio, then use reconcile; no request was resent.')
        record = {'state': 'SUBMITTING', 'request': request, 'request_sha256': digest(request), 'started': time.time(),
                  'previous_attempts': (old or {}).get('previous_attempts', [])}
        operations[key] = record
        self.save()  # Written before any potentially paid or persistent operation.
        try:
            response = self.api.request(method, path, body, upload=upload)
        except BaseException as exc:
            record.update(state='REJECTED' if isinstance(exc, APIError) and 400 <= exc.status < 500 else 'UNCERTAIN', error=str(exc))
            self.save()
            raise
        try:
            if path.endswith('/generate-concepts') or path.endswith('/generate-media'):
                if not isinstance(response.get('ids'), list) or not isinstance(response.get('skipped', []), list):
                    raise ValueError('Batch response needs ids and skipped lists.')
            elif path == '/api/workflow/import-scenes':
                if not response.get('document') or not response.get('segments'):
                    raise ValueError('Scene import response is incomplete.')
            elif path == '/api/assembly/scene-media':
                if not isinstance(response.get('assets'), list) or not isinstance(response.get('mapping'), dict):
                    raise ValueError('Scene media response is incomplete.')
            else:
                valid_id(response.get('id'), 'response.id')
        except (AttributeError, ValueError, StopRun) as exc:
            record.update(state='UNCERTAIN', error='Backend accepted the request but its response was incomplete: ' + str(exc))
            self.save()
            raise StopRun(record['error'] + ' Inspect Studio and reconcile; no request will be resent.') from exc
        record.update(state='SAVED', response=response, completed=time.time())
        self.save()
        return deepcopy(response)

    def preflight(self, stage, **extra):
        report = self.api.request('POST', '/api/production/preflight', {**self.scope, 'stage': stage, **extra})
        self.data['last_preflight'] = report
        self.save()
        for check in report.get('checks', []):
            if check.get('status') in {'warn', 'fail'}:
                self.emit(f"  {check['status'].upper()}: {check.get('message', '')}")
        if report.get('blocked', True):
            raise StopRun(f'{stage}: preflight blocked. Resolve the checks in Studio and resume this checkpoint.')
        return report

    def resource(self, kind, rid):
        data = self.read('/api/workflow/resources' + self.query)
        item = next((r for r in data.get('resources', []) if r['resource_kind'] == kind and r['id'] == rid), None)
        if item is None:
            raise StopRun(f'{kind} {rid} is missing or does not belong to this project and video.')
        return item

    def depends_on(self, kind, rid, source_kind, source_id):
        rows = self.read('/api/workflow/resources' + self.query).get('resources', [])
        graph = {(r['resource_kind'], r['id']): r for r in rows}
        pending, visited = [(kind, rid)], set()
        while pending:
            node = pending.pop()
            if node == (source_kind, source_id):
                return True
            if node in visited:
                continue
            visited.add(node)
            pending.extend((r['kind'], r['id']) for r in graph.get(node, {}).get('sources', []))
        return False

    def wait_job(self, group, jid):
        previous = None
        while True:
            if group == 'elevenlabs':
                job = self.read(f'/api/elevenlabs/jobs/{jid}')
            else:
                jobs = self.read(f'/api/{group}/status' + self.query).get('jobs', [])
                job = next((j for j in jobs if j['id'] == jid), None)
                if job is None:
                    raise StopRun(f'{group} job {jid} is missing from this video. Inspect Studio before continuing.')
            state = job.get('state')
            progress = job.get('progress') or job.get('phase') or job.get('completed_chunks')
            label = f'{group} {jid}: {state}' + (f' · {progress}' if progress else '')
            if label != previous:
                self.emit(label)
                previous = label
            self.data['current_job'] = {'kind': group, 'id': jid, 'state': state, 'progress': progress}
            self.save()
            if state == 'COMPLETED':
                return job
            if state in TERMINAL_ERRORS:
                raise StopRun(f'{group} job {jid} is {state}: {job.get("error") or "Review this job in Studio."} No automatic regeneration was requested.')
            self.sleep()

    def sleep(self):
        if self.deadline and time.monotonic() >= self.deadline:
            raise StopRun('CLI waiting time reached. Backend jobs remain active. Resume this checkpoint to continue watching; no work will be resubmitted.')
        time.sleep(self.poll)

    def artifact(self, name, url):
        record = self.data['artifacts'].get(name)
        if record and record['url'] != url:
            raise StopRun(f'Artifact identity changed for {name}. Inspect the saved checkpoint.')
        if not record:
            record = self.data['artifacts'][name] = {'url': url, 'path': str(self.path.parent / name), 'saved': False}
            self.save()
        target = Path(record['path'])
        if record['saved'] and target.is_file() and file_digest(target) == record.get('sha256'):
            return
        self.api.download(url, target)
        record.update(saved=True, sha256=file_digest(target), bytes=target.stat().st_size)
        self.save()

    def finish(self, stage, **result):
        self.data['stages'][stage] = {'state': 'COMPLETED', 'finished': time.time(), **result}
        self.save()

    def result(self, stage):
        return self.data['stages'][stage]

    def audio(self):
        cfg = self.config
        if cfg.get('audio_source'):
            source = cfg['audio_source']
            self.resource(source['kind'], source['id'])
            if source['kind'] == 'elevenlabs':
                job = self.wait_job('elevenlabs', source['id'])
                if not job.get('merged_url'):
                    raise StopRun('Narration chunks exist but merged audio is unavailable. Fix the merge in Studio, then resume.')
                self.artifact('merged.mp3', job['merged_url'])
            self.finish('audio', **source)
        elif cfg.get('audio_file'):
            path = cfg['audio_file']
            if not Path(path).is_file() or file_digest(path) != cfg['audio_file_sha256']:
                raise StopRun('The selected audio file changed or moved after this run started. Restore that file before resuming.')
            response = self.mutate('audio.import', '/api/whisperx/import', self.scope, upload=path)
            self.finish('audio', kind='audio', id=response['id'])
        else:
            if 'audio.submit' not in self.data['operations']:
                self.preflight('elevenlabs', text=cfg['narration_text'])
            body = {**self.scope, **cfg.get('tts', {}), 'title': cfg.get('title', 'CLI narration'), 'text': cfg['narration_text']}
            response = self.mutate('audio.submit', '/api/elevenlabs/jobs', body)
            job = self.wait_job('elevenlabs', response['id'])
            if not job.get('merged_url'):
                raise StopRun('Audio generation completed, but merged audio is missing: ' + (job.get('merge_error') or 'Check FFmpeg and the narration job in Studio.'))
            self.artifact('merged.mp3', job['merged_url'])
            self.finish('audio', kind='elevenlabs', id=job['id'])

    def whisperx(self):
        source = self.result('audio')
        if self.config.get('whisperx_id'):
            jid = self.config['whisperx_id']
            self.resource('whisperx', jid)
        else:
            if 'whisperx.submit' not in self.data['operations']:
                self.preflight('whisperx', source_id=source['id'], source_kind=source['kind'], device=self.config.get('whisperx', {}).get('device'))
            body = {**self.scope, **self.config.get('whisperx', {}), 'source_id': source['id']}
            jid = self.mutate('whisperx.submit', '/api/whisperx/jobs', body)['id']
        job = self.wait_job('whisperx', jid)
        if job.get('source_id') != source['id']:
            raise StopRun('WhisperX job belongs to a different audio source. Choose the matching job.')
        self.artifact('transcript.json', f'/api/whisperx/jobs/{jid}/result')
        if job.get('split_available'):
            for variant in ('video', 'image'):
                self.artifact(f'transcript_{variant}.json', f'/api/whisperx/jobs/{jid}/result/{variant}')
        self.finish('whisperx', id=jid)

    def srt(self):
        source = self.result('whisperx')['id']
        if self.config.get('srt_id'):
            jid = self.config['srt_id']
            self.resource('srt', jid)
        else:
            if 'srt.submit' not in self.data['operations']:
                self.preflight('srt', source_id=source, source_kind='whisperx')
            body = {**self.scope, **self.config.get('srt', {}), 'source_id': source, 'prompt': self.config['srt_instructions']}
            jid = self.mutate('srt.submit', '/api/srt/jobs', body)['id']
        job = self.wait_job('srt', jid)
        if not self.depends_on('srt', jid, 'whisperx', source):
            raise StopRun('SRT job belongs to a different transcript. Choose the matching SRT job.')
        quality = self.read(f'/api/srt/jobs/{jid}/quality')
        atomic_json(self.path.parent / 'srt-quality.json', quality)
        self.artifact('subtitles.srt', f'/api/srt/jobs/{jid}/result')
        if quality.get('status') not in {'PASSED', 'LEGACY'} and not quality.get('approved'):
            raise StopRun(f'SRT quality requires human review. Read {self.path.parent / "srt-quality.json"}, inspect and approve the SRT in Studio, then resume. CLI does not approve it automatically.')
        self.finish('srt', id=jid, quality=quality)

    def scenes(self):
        vid, sid = self.scope['video_id'], self.result('srt')['id']
        before = self.read(f'/api/storyboard/videos/{vid}')
        if before.get('segments'):
            source = (before.get('document') or {}).get('source') or {}
            if source.get('kind') != 'srt' or source.get('source_id') != sid:
                raise StopRun('This video already has scenes from a different SRT. Use a new video or resolve the source in Studio.')
            data = before
        else:
            data = self.mutate('scenes.import', '/api/workflow/import-scenes', {**self.scope, 'kind': 'srt', 'id': sid})
        segments = data.get('segments', [])
        if not segments:
            raise StopRun('No scenes were imported.')
        if len(segments) > 200:
            raise StopRun('CLI supports up to 200 scenes per batch. Use Studio to process this larger scene list in selected batches.')
        frozen = [{k: s[k] for k in ('id', 'ordinal', 'revision', 'start_ms', 'end_ms', 'text')} for s in segments]
        self.finish('scenes', document_id=data['document']['id'], document_revision=data['document']['revision'], segments=frozen)

    def document(self):
        data = self.read(f'/api/storyboard/videos/{self.scope["video_id"]}')
        saved = self.result('scenes')
        current = [{k: s[k] for k in ('id', 'ordinal', 'revision', 'start_ms', 'end_ms', 'text')} for s in data.get('segments', [])]
        doc = data.get('document') or {}
        if doc.get('id') != saved['document_id'] or doc.get('revision') != saved['document_revision'] or current != saved['segments']:
            raise StopRun('Scene text, timing or document revision changed after this run started. Review the edits and create a new run; current jobs were not resubmitted.')
        return data

    def selected(self, kind):
        scenes = self.result('scenes')['segments']
        media = self.config.get('media', {})
        mixed = media.get('visual_mode') == 'mixed'
        video_ordinals = media.get('video_scene_ordinals')
        known = {s['ordinal'] for s in scenes}
        if video_ordinals and set(video_ordinals) - known:
            raise StopRun('video_scene_ordinals contains numbers not present in the SRT.')
        cutoff = media.get('video_scene_seconds', 100)
        def is_video(s):
            return mixed and (s['ordinal'] in video_ordinals if video_ordinals is not None else s['start_ms'] < cutoff * 1000)
        return [s['id'] for s in scenes if is_video(s) == (kind == 'video')]

    def prompts(self, kind):
        stage = kind + '_prompts'
        ids = self.selected(kind)
        if not ids:
            self.finish(stage, ids=[], skipped=True)
            return
        data = self.document()
        response = self.data['operations'].get(stage + '.submit', {}).get('response')
        if response is None:
            unresolved = [s for s in data['segments'] if s['id'] in ids and not s.get(kind + '_ready') and (s.get('job') or {}).get('state') in TERMINAL_ERRORS]
            if unresolved:
                raise StopRun('Some prompt jobs need review. Resolve or retry those scenes in Studio first; CLI will not create replacements automatically.')
            if stage + '.submit' not in self.data['operations']:
                self.preflight(stage, segment_ids=ids)
            response = self.mutate(stage + '.submit', f'/api/storyboard/videos/{self.scope["video_id"]}/generate-concepts',
                {'segment_ids': ids, 'provider': 'chatgpt-web', 'prompt_kind': kind, 'regenerate': False})
        while True:
            data = self.document()
            selected = [s for s in data['segments'] if s['id'] in ids]
            ready = sum(bool(s.get(kind + '_ready')) for s in selected)
            self.emit(f'{stage}: {ready}/{len(ids)} scenes ready')
            if ready == len(ids):
                self.finish(stage, ids=response.get('ids', []), segment_ids=ids,
                            concepts={s['id']: s['active_concept']['id'] for s in selected},
                            prompts={s['id']: s['active_concept'][kind + '_prompt'] for s in selected})
                return
            failed = [s for s in selected if not s.get(kind + '_ready') and (s.get('job') or {}).get('state') in TERMINAL_ERRORS]
            if failed:
                raise StopRun(f'{stage}: scenes ' + ', '.join(str(s['ordinal']) for s in failed) + ' need review. Retry only selected failures in Studio, then resume this checkpoint.')
            self.sleep()

    def media(self, kind):
        stage = 'images' if kind == 'image' else 'videos'
        ids = self.selected(kind)
        if not ids:
            self.finish(stage, ids=[], skipped=True)
            return
        data = self.document()
        frozen_prompts = self.result(kind + '_prompts').get('prompts', {})
        if any((s.get('active_concept') or {}).get(kind + '_prompt') != frozen_prompts.get(s['id']) for s in data['segments'] if s['id'] in ids):
            raise StopRun('A saved prompt changed after the prompt stage. Review the new prompt and start a new run before generating media.')
        response = self.data['operations'].get(stage + '.submit', {}).get('response')
        if response is None:
            for scene in (s for s in data['segments'] if s['id'] in ids):
                jobs = [j for j in scene['media_jobs'] if j['kind'] == kind and j.get('current')]
                if jobs and jobs[0]['state'] in TERMINAL_ERRORS and not any(j['state'] == 'COMPLETED' for j in jobs):
                    raise StopRun(f'Scene {scene["ordinal"]} has a failed or uncertain {kind} job. Review it in Studio before continuing.')
            if stage + '.submit' not in self.data['operations']:
                self.preflight(stage, segment_ids=ids)
            options = self.config['media']
            body = {'segment_ids': ids, 'kind': kind, 'regenerate': False,
                    **{k: options[k] for k in ('orientation', 'image_model') if k in options}}
            if kind == 'video':
                body.update(duration=options.get('duration', 8), duration_mode=options.get('duration_mode', 'srt'))
            response = self.mutate(stage + '.submit', f'/api/storyboard/videos/{self.scope["video_id"]}/generate-media', body)
        while True:
            data = self.document()
            selected = [s for s in data['segments'] if s['id'] in ids]
            ready, failures = [], []
            for scene in selected:
                jobs = [j for j in scene['media_jobs'] if j['kind'] == kind and j.get('current')]
                completed = next((j for j in jobs if j['state'] == 'COMPLETED' and j.get('files')), None)
                if completed:
                    ready.append(completed['id'])
                elif jobs and jobs[0]['state'] in TERMINAL_ERRORS:
                    failures.append(scene['ordinal'])
            self.emit(f'{stage}: {len(ready)}/{len(ids)} scenes saved')
            if len(ready) == len(ids):
                self.finish(stage, ids=ready, segment_ids=ids)
                return
            if failures:
                raise StopRun(f'{stage}: scenes {failures} need review. Resume saved Flow results or retry selected failures in Studio, then resume this checkpoint.')
            self.sleep()

    def assembly(self):
        self.document()
        srt = self.mutate('assembly.srt-source', '/api/assembly/source', {**self.scope, 'kind': 'srt', 'source_id': self.result('srt')['id']})
        audio = self.mutate('assembly.audio-source', '/api/assembly/source', {**self.scope, 'kind': 'audio', 'source_id': self.result('audio')['id']})
        mode = self.config['media']['visual_mode']
        media = self.mutate('assembly.scene-media', '/api/assembly/scene-media', {**self.scope, 'srt_id': srt['id'], 'visual_mode': mode})
        video_scenes = set(self.selected('video'))
        selected_mapping = {}
        for scene in self.result('scenes')['segments']:
            kind = 'video' if scene['id'] in video_scenes else 'image'
            stage = 'videos' if kind == 'video' else 'images'
            job_ids = set(self.result(stage)['ids'])
            asset = next((a for a in media.get('assets', []) if a['kind'] == kind and
                a.get('metadata', {}).get('segment_id') == scene['id'] and
                a.get('metadata', {}).get('media_job_id') in job_ids), None)
            if not asset:
                raise StopRun(f'Assembly scene {scene["ordinal"]} no longer has the exact saved {kind} from this run. Check changed prompts or missing media in Studio.')
            selected_mapping[str(scene['ordinal'])] = asset['id']
        body = {**self.scope, **self.config.get('assembly', {}), 'title': self.config.get('title', 'CLI video'),
                'srt_id': srt['id'], 'audio_id': audio['id'], 'visual_mode': mode, 'mapping': selected_mapping,
                'image_ids': [a['id'] for a in media['assets'] if a['kind'] == 'image'],
                'video_ids': [a['id'] for a in media['assets'] if a['kind'] == 'video']}
        if 'assembly.submit' not in self.data['operations']:
            self.preflight('assembly', plan=body)
        response = self.mutate('assembly.submit', '/api/assembly/jobs', body)
        job = self.wait_job('assembly', response['id'])
        self.artifact('video.mp4', f'/api/assembly/jobs/{job["id"]}/video')
        self.finish('assembly', id=job['id'])

    def run(self, *, continuous=False, until=None):
        self.deadline = time.monotonic() + self.wait_timeout if self.wait_timeout else None
        unresolved = [key for key, value in self.data['operations'].items() if value['state'] in {'SUBMITTING', 'UNCERTAIN', 'REJECTED'}]
        if unresolved:
            raise StopRun('Unresolved submission: ' + ', '.join(unresolved) + '. Inspect Studio and use reconcile before resuming; nothing was resent.')
        self.data['state'] = 'RUNNING'
        self.save()
        stages = [s for s in STAGES if self.config['media']['visual_mode'] == 'mixed' or s not in {'video_prompts', 'videos'}]
        if until and until not in stages:
            raise StopRun('The requested --until stage is not part of this manifest.')
        count = 0
        try:
            for stage in stages:
                if until and stages.index(stage) > stages.index(until):
                    break
                if self.data['stages'].get(stage, {}).get('state') == 'COMPLETED':
                    continue
                self.emit(f'Stage: {stage}')
                if stage.endswith('_prompts'):
                    self.prompts(stage.split('_')[0])
                elif stage in {'images', 'videos'}:
                    self.media('image' if stage == 'images' else 'video')
                else:
                    getattr(self, stage)()
                count += 1
                if not continuous:
                    break
            self.data['state'] = 'COMPLETED' if all(s in self.data['stages'] for s in stages) else 'PAUSED'
            self.data.pop('stop_reason', None)
            self.save()
            self.emit(f'{self.data["state"]}: {count} stage(s) completed. Checkpoint: {self.path}')
            if self.data['state'] == 'PAUSED':
                self.emit('Inspect this stage in Studio, then run with --resume and this checkpoint path. Add --continuous only to opt into subsequent stages.')
        except BaseException as exc:
            self.data.update(state='STOPPED', stop_reason=str(exc) or type(exc).__name__)
            self.save()
            raise

    def reconcile(self, key, *, response=None, not_submitted=False, reviewed=False):
        if not reviewed:
            raise StopRun('Reconciliation requires --reviewed after inspecting Studio and provider pages/downloads.')
        record = self.data['operations'].get(key)
        if not record or record['state'] not in {'SUBMITTING', 'UNCERTAIN', 'REJECTED'}:
            raise StopRun('Select an unresolved operation from the saved checkpoint.')
        if not_submitted:
            record.setdefault('previous_attempts', []).append({k: v for k, v in record.items() if k != 'previous_attempts'})
            record.update(state='NOT_SUBMITTED', reviewed=time.time())
        else:
            if not isinstance(response, dict):
                raise StopRun('Provide a JSON object containing the actual saved backend response.')
            self.validate_reconciliation(record['request'], response)
            record.update(state='SAVED', response=response, reviewed=time.time())
        self.save()
        self.emit('Reconciliation saved. Resume the same checkpoint when ready.')

    def validate_reconciliation(self, request, response):
        path, body = request['path'], request['body']
        groups = {'/api/elevenlabs/jobs': 'elevenlabs', '/api/whisperx/import': 'audio', '/api/whisperx/jobs': 'whisperx',
                  '/api/srt/jobs': 'srt', '/api/assembly/source': 'asset', '/api/assembly/jobs': 'assembly'}
        if path in groups:
            rid = valid_id(response.get('id'), 'response.id')
            item = self.resource(groups[path], rid)
            if groups[path] != 'whisperx' and item.get('created', 0) and item['created'] < self.data['created'] - 5:
                raise StopRun('This result predates the run. Verify that it is the actual submitted job.')
            if body.get('source_id'):
                source_kind = {'/api/whisperx/jobs': self.result('audio')['kind'], '/api/srt/jobs': 'whisperx'}.get(path) if path in {'/api/whisperx/jobs', '/api/srt/jobs'} else None
                if source_kind and not self.depends_on(groups[path], rid, source_kind, body['source_id']):
                    raise StopRun('Recovered result refers to a different source.')
                if not source_kind and item.get('sources') and not any(s.get('id') == body['source_id'] for s in item['sources']):
                    raise StopRun('Recovered result refers to a different source.')
            return
        if path.endswith('/generate-concepts'):
            document = self.document()
            found = {s['job']['id']: s['id'] for s in document['segments'] if s.get('job')}
            ids = response.get('ids')
            skipped = response.get('skipped', [])
            if not isinstance(ids, list) or any(i not in found or found[i] not in body['segment_ids'] for i in ids) or set(skipped) - set(body['segment_ids']):
                raise StopRun('Recovered prompt IDs must match jobs and scenes in this video.')
            if set(found[i] for i in ids) | set(skipped) != set(body['segment_ids']):
                raise StopRun('Recover every submitted/skipped scene, not a partial response.')
            return
        if path.endswith('/generate-media'):
            jobs = self.read('/api/desktop/jobs')['jobs']
            mapping = {j['id']: j['payload'] for j in jobs}
            ids, skipped = response.get('ids'), response.get('skipped', [])
            if not isinstance(ids, list) or any(i not in mapping or mapping[i].get('video_id') != self.scope['video_id'] or mapping[i].get('kind') != body['kind'] or mapping[i].get('segment_id') not in body['segment_ids'] for i in ids):
                raise StopRun('Recovered media IDs must match this video, media kind and scene list.')
            if {mapping[i]['segment_id'] for i in ids} | set(skipped) != set(body['segment_ids']):
                raise StopRun('Recover every submitted/skipped scene, not a partial response.')
            return
        if path == '/api/workflow/import-scenes':
            document = self.read(f'/api/storyboard/videos/{self.scope["video_id"]}')
            source = (document.get('document') or {}).get('source') or {}
            if source.get('source_id') != body['id'] or response != document:
                raise StopRun('Recover the exact current storyboard response for the expected SRT.')
            return
        if path == '/api/assembly/scene-media':
            for asset in response.get('assets', []):
                self.resource('asset', valid_id(asset.get('id'), 'asset.id'))
            if not response.get('mapping') or set(response['mapping'].values()) - {a['id'] for a in response.get('assets', [])}:
                raise StopRun('Recovered assembly mapping must reference saved assets in this video.')
            return
        raise StopRun('This operation cannot be reconciled automatically; inspect its backend result first.')


def parser():
    p = argparse.ArgumentParser(description='Flowkit Studio pipeline CLI using the existing local backend and extensions.')
    p.add_argument('--backend', default='http://127.0.0.1:8100', help='Local Studio backend URL')
    sub = p.add_subparsers(dest='command', required=True)
    status = sub.add_parser('status', help='Show video progress or a saved run')
    status.add_argument('--project-id')
    status.add_argument('--video-id')
    status.add_argument('--resume', type=Path)
    preflight = sub.add_parser('preflight', help='Read-only stage checks; no generation')
    preflight.add_argument('--manifest', required=True, type=Path)
    preflight.add_argument('--stage', required=True, choices=STAGES + ('elevenlabs',))
    run = sub.add_parser('run', help='Run one stage by default; opt into subsequent stages with --continuous')
    source = run.add_mutually_exclusive_group(required=True)
    source.add_argument('--manifest', type=Path)
    source.add_argument('--resume', type=Path)
    run.add_argument('--checkpoint', type=Path, help='New run path; only with --manifest')
    run.add_argument('--continuous', action='store_true')
    run.add_argument('--until', choices=STAGES)
    run.add_argument('--poll', type=float, default=3)
    run.add_argument('--wait-timeout', type=float, default=3600, help='Seconds to watch this invocation; backend work continues after timeout')
    reconcile = sub.add_parser('reconcile', help='Resolve a lost submission response after manual review')
    reconcile.add_argument('--resume', type=Path, required=True)
    reconcile.add_argument('--operation', required=True)
    choice = reconcile.add_mutually_exclusive_group(required=True)
    choice.add_argument('--response-file', type=Path)
    choice.add_argument('--not-submitted', action='store_true')
    reconcile.add_argument('--reviewed', action='store_true')
    return p


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        api = Backend(args.backend)
        if args.command == 'status':
            if args.resume:
                runner = Runner.load(api, args.resume)
                output = {k: runner.data.get(k) for k in ('id', 'state', 'current_job', 'stop_reason', 'stages', 'artifacts')}
                output['unresolved'] = {k: {'state': v['state'], 'error': v.get('error')} for k, v in runner.data['operations'].items() if v['state'] != 'SAVED'}
            else:
                scope = {'project_id': valid_id(args.project_id, 'project_id'), 'video_id': valid_id(args.video_id, 'video_id')}
                output = api.request('GET', '/api/production/overview?' + urlencode(scope))
            print(json.dumps(output, ensure_ascii=False, indent=2))
            return 0
        if args.command == 'preflight':
            cfg = freeze_defaults(manifest_config(args.manifest), api)
            stage = 'elevenlabs' if args.stage == 'audio' else args.stage
            if stage == 'scenes':
                raise StopRun('Scene import is checked against the saved SRT during run; use preflight --stage srt for provider readiness.')
            body = {k: cfg[k] for k in ('project_id', 'video_id')}
            body['stage'] = stage
            if stage == 'elevenlabs':
                body['text'] = cfg.get('narration_text', '')
            if stage == 'whisperx':
                body['device'] = cfg.get('whisperx', {}).get('device')
                if cfg.get('audio_source'):
                    body.update(source_id=cfg['audio_source']['id'], source_kind=cfg['audio_source']['kind'])
            if stage == 'srt' and cfg.get('whisperx_id'):
                body.update(source_id=cfg['whisperx_id'], source_kind='whisperx')
            report = api.request('POST', '/api/production/preflight', body)
            print(json.dumps(report, ensure_ascii=False, indent=2))
            return 2 if report.get('blocked', True) else 0
        if args.command == 'reconcile':
            with checkpoint_lock(args.resume):
                runner = Runner.load(api, args.resume)
                response = json.loads(args.response_file.read_text(encoding='utf-8-sig')) if args.response_file else None
                runner.reconcile(args.operation, response=response, not_submitted=args.not_submitted, reviewed=args.reviewed)
            return 0
        if not math.isfinite(args.poll) or not math.isfinite(args.wait_timeout) or args.poll <= 0 or args.wait_timeout < 0:
            raise StopRun('--poll must be positive and --wait-timeout cannot be negative.')
        if args.resume and args.checkpoint:
            raise StopRun('--checkpoint is only used when creating a new run.')
        if args.resume:
            path = args.resume
        else:
            path = args.checkpoint or Path(manifest_config(args.manifest)['output_dir']) / 'runs' / str(uuid4()) / 'run.json'
        with checkpoint_lock(path):
            runner = Runner.load(api, path, poll=args.poll, wait_timeout=args.wait_timeout) if args.resume else Runner.create(api, args.manifest, path, poll=args.poll, wait_timeout=args.wait_timeout)
            print(f'Run checkpoint: {runner.path}')
            runner.run(continuous=args.continuous, until=args.until)
        return 0
    except KeyboardInterrupt:
        print('Stopped watching. Backend jobs may continue. Resume the same checkpoint to recover safely.', file=sys.stderr)
        return 130
    except (StopRun, OSError, ValueError, KeyError) as exc:
        print(f'STOPPED: {exc}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
