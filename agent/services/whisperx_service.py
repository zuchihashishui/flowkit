"""Durable, one-at-a-time local transcription queue. No WhisperX imports in the API."""
from agent.services import output_paths

from agent.services import workflow_scope as scope

import asyncio
import codecs
import logging
from contextlib import contextmanager
import json
import math
import os
from pathlib import Path
import sqlite3
import time
import uuid

from agent.config import BASE_DIR, OUTPUT_DIR
from agent.services.elevenlabs_bridge import bridge as narration
from agent.services.transcript_split import DEFAULT_VIDEO_SECONDS, FILES, validate_seconds, write_split

ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / 'tools' / 'whisperx' / 'runner.py'
logger = logging.getLogger(__name__)


def python_bin():
    return os.environ.get('WHISPERX_PYTHON_BIN') or str(ROOT / '.venv-whisperx' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python'))


class WhisperXService:
    def __init__(self, store=None, output=None, source=None):
        self.store = Path(store or BASE_DIR / 'whisperx_jobs.db')
        self.output = Path(output or OUTPUT_DIR / 'whisperx')
        self.source = source or narration
        self.process = None
        self.active_id = None
        self.split_locks = set()
        self.loop_running = False
        self.queue_error = None

    @contextmanager
    def db(self):
        self.store.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.store)
        try:
            db.row_factory = sqlite3.Row
            db.executescript('''CREATE TABLE IF NOT EXISTS wx_jobs (
                id TEXT PRIMARY KEY, source_id TEXT NOT NULL, title TEXT, state TEXT NOT NULL,
                phase TEXT, error TEXT, options TEXT NOT NULL, created REAL, updated REAL);
                CREATE TABLE IF NOT EXISTS wx_settings (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS wx_sources (id TEXT PRIMARY KEY, title TEXT NOT NULL, filename TEXT NOT NULL, bytes INTEGER, created REAL);''')
            columns = {row['name'] for row in db.execute('PRAGMA table_info(wx_jobs)')}
            for name, definition in [('progress', "TEXT NOT NULL DEFAULT '{}'"), ('started', 'REAL'), ('finished', 'REAL')]:
                if name not in columns:
                    db.execute(f'ALTER TABLE wx_jobs ADD COLUMN {name} {definition}')
            scope.initialize(db)
            with db:
                yield db
        finally:
            db.close()

    def settings(self):
        defaults = {'auto': False, 'enabled_at': 0, 'model': 'large-v3',
                    'device': 'cuda', 'language': '', 'batch_size': 8, 'video_duration_seconds': DEFAULT_VIDEO_SECONDS,
                    'device_default_version': 1, 'manual_stages_version': 1}
        with self.db() as db:
            row = db.execute('SELECT value FROM wx_settings WHERE id=1').fetchone()
            if not row:
                return defaults
            saved = json.loads(row[0])
            settings = {**defaults, **saved}
            if not saved.get('manual_stages_version'):
                settings.update(auto=False, manual_stages_version=1)
                db.execute('UPDATE wx_settings SET value=? WHERE id=1', (json.dumps(settings),))
            if saved.get('device_default_version', 0) < 1:
                # Apply the new default once; later explicit Auto/CPU choices persist.
                if settings['device'] == 'auto':
                    settings['device'] = 'cuda'
                settings['device_default_version'] = 1
                db.execute('UPDATE wx_settings SET value=? WHERE id=1', (json.dumps(settings),))
            return settings

    def configure(self, values):
        old = self.settings()
        new = {**old, **values}
        validate_seconds(new['video_duration_seconds'])
        if new['auto'] and not old['auto']:
            new['enabled_at'] = time.time()
            new['existing_sources'] = [j['id'] for j in self.source.jobs() if j.get('merged_url')]
        with self.db() as db:
            db.execute('INSERT OR REPLACE INTO wx_settings VALUES(1,?)', (json.dumps(new),))
        return new

    def jobs(self, filters=None):
        where, params = scope.job_filter('whisperx', 'id', filters)
        with self.db() as db:
            rows = db.execute(f'SELECT * FROM wx_jobs {where} ORDER BY created DESC LIMIT 500', params).fetchall()
        return [self.public_job(row) for row in rows]

    def public_job(self, row):
        job = dict(row)
        job['options'] = json.loads(job['options'])
        job['progress'] = json.loads(job.get('progress') or '{}')
        end = job.get('finished') or time.time()
        job['elapsed_seconds'] = max(0, end-job['started']) if job.get('started') else 0
        job['result_available'] = job['state'] == 'COMPLETED'
        job['can_retry'] = job['state'] in ('FAILED', 'INTERRUPTED')
        job['transcript_split'] = job['progress'].get('transcript_split')
        job['split_available'] = job['result_available'] and bool(job['transcript_split']) and job['id'] not in self.split_locks
        return job

    def job(self, jid):
        with self.db() as db:
            row = db.execute('SELECT * FROM wx_jobs WHERE id=?', (jid,)).fetchone()
        if not row:
            raise KeyError('Transcription job not found.')
        return self.public_job(row)

    def imported_sources(self):
        with self.db() as db:
            rows = db.execute('SELECT id,title,bytes,created FROM wx_sources ORDER BY created DESC').fetchall()
        return [dict(row) for row in rows]

    def resolve_source(self, source_id):
        with self.db() as db:
            row = db.execute('SELECT * FROM wx_sources WHERE id=?', (source_id,)).fetchone()
        if row:
            return dict(row), output_paths.resource_path(self, 'audio', source_id, self.output / '_imports' / row['filename'], 'audio/' + row['filename'])
        return self.source.job(source_id), self.source.audio_path(source_id, 'merged')

    async def import_audio(self, upload, context=None):
        name = (upload.filename or '').replace('\\', '/').rsplit('/', 1)[-1]
        extension = Path(name).suffix.lower()
        if extension not in {'.mp3','.wav','.m4a','.flac','.ogg','.opus','.aac'}:
            raise ValueError('Choose MP3, WAV, M4A, FLAC, OGG, OPUS or AAC audio.')
        source_id = str(uuid.uuid4())
        folder = self.output / '_imports'
        folder.mkdir(parents=True, exist_ok=True)
        target = output_paths.owned_path(folder / (source_id + extension), context, 'audio/' + source_id + extension)
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(extension + '.part')
        size = 0
        try:
            with temporary.open('wb') as output:
                while chunk := await upload.read(1024 * 1024):
                    output.write(chunk)
                    size += len(chunk)
            if size == 0:
                raise ValueError('The selected audio file is empty.')
            os.replace(temporary, target)
            title = name[:200]
            with self.db() as db:
                db.execute('INSERT INTO wx_sources VALUES(?,?,?,?,?)',
                           (source_id, title, target.name, size, time.time()))
                scope.record(db, 'audio', source_id, context)
                output_paths.remember(db, 'audio', source_id, target)
            return {'id': source_id, 'title': title, 'bytes': size}
        except BaseException:
            target.unlink(missing_ok=True)
            raise
        finally:
            temporary.unlink(missing_ok=True)

    def enqueue(self, source_id, options, automatic=False, context=None):
        options = {**options, 'video_duration_seconds': validate_seconds(options.get('video_duration_seconds', DEFAULT_VIDEO_SECONDS))}
        source, audio = self.resolve_source(source_id)
        if not audio.is_file():
            raise ValueError('The selected audio file is not available.')
        source_ref = scope.audio_ref(self, source_id)
        if context is None:
            owner = self if source_ref['kind'] == 'audio' else self.source
            if hasattr(owner, 'db'):
                with owner.db() as source_db:
                    context = scope.ownership(source_db, source_ref['kind'], source_id)
        with self.db() as db:
            prior = db.execute("SELECT id FROM wx_jobs WHERE source_id=? AND (state IN ('QUEUED','RUNNING') OR ?) ORDER BY created DESC LIMIT 1", (source_id, automatic)).fetchone()
            if prior:
                return self.job(prior['id'])
            jid, now = str(uuid.uuid4()), time.time()
            db.execute('INSERT INTO wx_jobs(id,source_id,title,state,phase,error,options,created,updated) VALUES(?,?,?,?,?,?,?,?,?)',
                       (jid, source_id, source['title'], 'QUEUED', 'QUEUED', None, json.dumps(options), now, now))
            scope.record(db, 'whisperx', jid, context, [source_ref])
        return self.job(jid)

    def update(self, jid, **values):
        with self.db() as db:
            values['updated'] = time.time()
            db.execute('UPDATE wx_jobs SET ' + ','.join(k + '=?' for k in values) + ' WHERE id=?',
                       (*values.values(), jid))

    def retry(self, jid):
        """Explicit local retry in a new job; preserve the original attempt/files."""
        previous = self.job(jid)
        _, audio = self.resolve_source(previous['source_id'])
        if not audio.is_file():
            raise ValueError('The original audio file is missing. Import it again before starting a new transcription.')
        source_ref = scope.audio_ref(self, previous['source_id'])
        with self.db() as db:
            # Serialize the eligibility check and insert, including repeated UI clicks.
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT * FROM wx_jobs WHERE id=?', (jid,)).fetchone()
            if not row or row['state'] not in ('FAILED', 'INTERRUPTED'):
                raise ValueError('Only failed or interrupted transcriptions can be retried. Completed JSON is kept unchanged.')
            if db.execute("SELECT 1 FROM wx_jobs WHERE source_id=? AND state IN ('QUEUED','RUNNING')", (row['source_id'],)).fetchone():
                raise ValueError('A transcription for this audio is already queued or running.')
            new_id, now = str(uuid.uuid4()), time.time()
            db.execute('INSERT INTO wx_jobs(id,source_id,title,state,phase,error,options,created,updated) VALUES(?,?,?,?,?,?,?,?,?)',
                       (new_id, row['source_id'], row['title'], 'QUEUED', 'QUEUED', None, row['options'], now, now))
            scope.record(db, 'whisperx', new_id, scope.ownership(db, 'whisperx', jid),
                         [source_ref, scope.ref('whisperx', jid)])
        return {'id': new_id, 'retried': True, 'previous_id': jid}

    def worker_progress(self, jid, data):
        job = self.job(jid)
        if job['state'] != 'RUNNING':
            return  # Late stdout must not overwrite cancelled/failed state.
        phase = data.get('phase')
        if phase not in {'STARTING', 'LOADING_MODEL', 'READING_AUDIO', 'TRANSCRIBING', 'LOADING_ALIGNMENT_MODEL', 'ALIGNING', 'WRITING_JSON', 'SPLITTING_JSON', 'COMPLETED'}:
            return
        if phase == 'COMPLETED':
            phase = 'VERIFYING_JSON'  # Only the backend can declare durable success.
        now = time.time()
        progress = job['progress']
        if phase != job['phase']:
            for key in ['phase_percent', 'segments_done', 'segments_total', 'units_done', 'units_total', 'unit', 'audio_done_seconds']:
                progress.pop(key, None)
            progress['phase_started_at'] = now
        progress.setdefault('phase_started_at', now)
        progress['updated_at'] = now
        progress['message'] = str(data.get('message', ''))[:500]
        for key in ['phase_percent', 'audio_seconds', 'audio_done_seconds', 'segments_done', 'segments_total', 'units_done', 'units_total', 'output_words', 'output_segments']:
            value = data.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
                progress[key] = min(100, value) if key == 'phase_percent' else value
        for key in ['unit', 'language', 'device_used']:
            if isinstance(data.get(key), str):
                progress[key] = data[key][:40]
        if phase == 'VERIFYING_JSON':
            progress.pop('phase_percent', None)
            progress['message'] = 'Verifying the saved JSON before marking this job complete.'
        self.update(jid, phase=phase, progress=json.dumps(progress))

    def result_path(self, jid, variant='full'):
        if variant not in FILES:
            raise ValueError('Unknown transcript file.')
        if self.job(jid)['state'] != 'COMPLETED':
            raise ValueError('JSON is not ready.')
        if variant != 'full' and jid in self.split_locks:
            raise ValueError('Transcript split is still being saved.')
        path = output_paths.job_directory(self, 'whisperx', jid) / FILES[variant]
        if not path.is_file():
            raise ValueError('Saved JSON is missing. Use Split saved JSON for an older completed job.' if variant != 'full' else 'Saved JSON is missing.')
        return path

    async def split_saved(self, jid, video_seconds):
        validate_seconds(video_seconds)
        source = self.result_path(jid)
        if jid in self.split_locks:
            raise ValueError('This transcript is already being split.')
        self.split_locks.add(jid)
        try:
            report = await asyncio.to_thread(write_split, source, video_seconds)
            progress = self.job(jid)['progress']
            progress['transcript_split'] = report
            self.update(jid, progress=json.dumps(progress))
        finally:
            self.split_locks.discard(jid)
        return self.job(jid)

    async def cancel(self, jid):
        job = self.job(jid)
        if job['state'] in ('QUEUED', 'RUNNING'):
            self.update(jid, state='CANCELLED', phase='CANCELLED', finished=time.time())
            if self.active_id == jid and self.process and self.process.returncode is None:
                self.process.terminate()
        return self.job(jid)

    async def check(self):
        logger.info('WhisperX environment check starting: %s (timeout 90 seconds)', python_bin())
        process = None
        try:
            process = await asyncio.create_subprocess_exec(python_bin(), str(RUNNER), '--check',
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
            stdout, _ = await asyncio.wait_for(process.communicate(), 90)
            text = stdout.decode('utf-8', errors='replace')
            for line in text.splitlines():
                if line.startswith('FLOWKIT_CHECK '):
                    report = json.loads(line[len('FLOWKIT_CHECK '):])
                    if not isinstance(report, dict) or not isinstance(report.get('ok'), bool):
                        raise ValueError('Invalid FLOWKIT_CHECK response: expected an object with boolean ok.')
                    if process.returncode != 0:
                        return {'ok': False, 'python': python_bin(), 'error': f'WhisperX check exited with code {process.returncode}: {text[-2500:]}'}
                    logger.info('WhisperX environment check completed: ok=%s', report['ok'])
                    return report
            return {'ok': False, 'python': python_bin(), 'error': text[-2500:] or 'Environment check failed.'}
        except NotImplementedError:
            return {'ok': False, 'python': python_bin(), 'error':
                    'This backend event loop does not support subprocesses. On Windows, stop the backend '
                    'started through uvicorn directly and restart the updated Studio, or run python -m agent.main (GLA_RELOAD=0).'}
        except (OSError, ValueError, asyncio.TimeoutError) as error:
            return {'ok': False, 'python': python_bin(), 'error':
                    f'{type(error).__name__}: {str(error) or "WhisperX import check exceeded 90 seconds."}'}
        finally:
            if process and process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass  # The check may exit between returncode inspection and kill.
                await process.wait()

    def activity_log(self, jid):
        try:
            path = output_paths.job_directory(self, 'whisperx', jid) / 'worker.log'
            if not path.is_file():
                return {'job_id': jid, 'text': 'Worker log has not been created yet.'}
            with path.open('rb') as log:
                log.seek(max(0, path.stat().st_size - 16384))
                text = log.read(16384).decode('utf-8', errors='replace')
            return {'job_id': jid, 'text': text, 'path': str(path)}
        except (OSError, ValueError) as error:
            return {'job_id': jid, 'text': 'Cannot read worker log: ' + str(error)}

    async def step(self):
        if self.active_id:
            return
        with self.db() as db:
            row = db.execute("SELECT id FROM wx_jobs WHERE state='QUEUED' ORDER BY created LIMIT 1").fetchone()
        if not row:
            return
        jid = row['id']
        self.active_id = jid
        log_path = None
        try:
            self.update(jid, state='RUNNING', phase='STARTING', error=None, started=time.time(), finished=None, progress='{}')
            logger.info('WhisperX job %s starting with %s', jid, python_bin())
            directory = output_paths.job_directory(self, 'whisperx', jid)
            job = self.job(jid)
            directory.mkdir(parents=True, exist_ok=True)
            log_path = directory / 'worker.log'
            log_path.write_text('Starting WhisperX worker. Python: ' + python_bin() + '\n', encoding='utf-8')
            request = {'audio': str(self.resolve_source(job['source_id'])[1].resolve()),
                       'output': str((directory / 'transcript.json').resolve()), 'options': job['options']}
            request_file = directory / 'request.json'
            request_file.write_text(json.dumps(request), encoding='utf-8')
            env = {**os.environ, 'PYTHONUNBUFFERED': '1', 'PYTHONIOENCODING': 'utf-8'}
            self.process = await asyncio.create_subprocess_exec(python_bin(), str(RUNNER), '--request', str(request_file),
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, env=env, limit=1024*1024)
            if self.job(jid)['state'] == 'CANCELLED':
                self.process.terminate()
            async def read_output():
                decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')
                pending = ''
                def consume(line):
                    if line.startswith('FLOWKIT_WX '):
                        try:
                            data = json.loads(line[len('FLOWKIT_WX '):])
                            if isinstance(data, dict):
                                self.worker_progress(jid, data)
                                logger.info('WhisperX job %s: %s — %s', jid, data.get('phase'), data.get('message', ''))
                        except (ValueError, KeyError):
                            pass
                with log_path.open('a', encoding='utf-8') as log:
                    while True:
                        raw = await self.process.stdout.read(4096)
                        text = decoder.decode(raw, final=not raw)
                        log.write(text); log.flush()
                        pending += text.replace('\r', '\n')
                        while '\n' in pending:
                            line, pending = pending.split('\n', 1)
                            consume(line)
                        pending = pending[-65536:]
                        if not raw:
                            if pending:
                                consume(pending)
                            break
                return await self.process.wait()
            code = await asyncio.wait_for(read_output(), 6*3600)
            if self.job(jid)['state'] == 'CANCELLED':
                return
            if code != 0:
                with (directory / 'worker.log').open('rb') as log:
                    log.seek(max(0, (directory / 'worker.log').stat().st_size - 2500))
                    raise RuntimeError(log.read().decode('utf-8', errors='replace'))
            result = json.loads((directory / 'transcript.json').read_text(encoding='utf-8'))
            if not isinstance(result.get('segments'), list) or not isinstance(result.get('word_segments'), list):
                raise ValueError('WhisperX did not produce aligned JSON.')
            self.worker_progress(jid, {'phase':'SPLITTING_JSON', 'message':'Saving video and image transcripts; original JSON stays unchanged.'})
            split_report = await asyncio.to_thread(write_split, directory / 'transcript.json', job['options'].get('video_duration_seconds', DEFAULT_VIDEO_SECONDS))
            if self.job(jid)['state'] == 'CANCELLED':
                return
            progress = self.job(jid)['progress']
            progress.update(phase_percent=100, output_words=len(result['word_segments']), output_segments=len(result['segments']),
                            transcript_split=split_report, message='All three JSON files saved and validated.', updated_at=time.time())
            if 'audio_seconds' in progress:
                progress['audio_done_seconds'] = progress['audio_seconds']
            self.update(jid, state='COMPLETED', phase='COMPLETED', progress=json.dumps(progress), finished=time.time())
        except asyncio.CancelledError:
            if self.job(jid)['state'] != 'CANCELLED':
                self.update(jid, state='INTERRUPTED', phase='INTERRUPTED', error='Backend stopped. Use Retry job to transcribe the same audio with the saved options.', finished=time.time())
            raise
        except Exception as error:
            logger.exception('WhisperX job %s failed', jid)
            message = f'{type(error).__name__}: {str(error) or "Transcription exceeded six hours."}'
            if isinstance(error, NotImplementedError):
                message = 'Windows subprocess support is unavailable. Stop the backend and restart Studio, or run python -m agent.main with GLA_RELOAD=0.'
            if log_path:
                try:
                    with log_path.open('a', encoding='utf-8') as log:
                        log.write('\nFAILED: ' + message + '\n')
                except OSError:
                    pass
            if self.job(jid)['state'] != 'CANCELLED':
                self.update(jid, state='FAILED', phase='FAILED', error=message[-2500:], finished=time.time())
        finally:
            try:
                if self.process and self.process.returncode is None:
                    try:
                        self.process.kill()
                    except ProcessLookupError:
                        pass
                    await self.process.wait()
            finally:
                self.process = None
                self.active_id = None

    async def discover(self):
        settings = self.settings()
        if not settings['auto']:
            return
        for source in self.source.jobs():
            if hasattr(self.source, 'db'):
                with self.source.db() as db:
                    if scope.ownership(db, 'elevenlabs', source['id'])['video_id']:
                        continue
            if source.get('merged_url') and source['id'] not in settings.get('existing_sources', []):
                try:
                    self.enqueue(source['id'], {k: settings[k] for k in ('model','device','language','batch_size','video_duration_seconds')}, automatic=True)
                except (KeyError, ValueError, FileNotFoundError):
                    # Removed/archived source audio must not block other queued work.
                    continue

    async def run(self):
        self.loop_running = True
        try:
            with self.db() as db:
                db.execute("UPDATE wx_jobs SET state='INTERRUPTED',phase='INTERRUPTED',finished=?,error='Backend restarted. Use Retry job to transcribe the same audio with the saved options.' WHERE state='RUNNING'", (time.time(),))
            while True:
                try:
                    await self.discover()
                    await self.step()
                    self.queue_error = None
                except Exception as error:
                    self.queue_error = f'{type(error).__name__}: {error}'
                    logger.exception('WhisperX queue error')
                await asyncio.sleep(2)
        finally:
            self.loop_running = False


service = WhisperXService()
