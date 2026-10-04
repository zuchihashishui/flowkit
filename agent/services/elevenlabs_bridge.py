"""Local ElevenLabs browser bridge; one paid generation at a time, durable before ACK.

No cookies, provider API keys or remote audio URLs pass through this service.
"""
from agent.services import workflow_scope as scope

import asyncio
import base64
import binascii
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import time
import uuid

from agent.config import BASE_DIR, OUTPUT_DIR

MAX_AUDIO_BYTES = 10 * 1024 * 1024
MAX_TEXT_CHARACTERS = 500_000
DEFAULT_MODEL = 'Eleven v4'


class BridgeError(RuntimeError):
    pass


def utf16_length(text):
    return sum(2 if ord(char) > 0xFFFF else 1 for char in text)


def split_text(text, minimum=None, maximum=3000):
    """Lossless Python/code-point offsets, capped by browser UTF-16 character count.

Prefer paragraph/sentence ends within the target window, then whitespace. A
    long unbroken sentence is hard-split; the final chunk can be below minimum.
    """
    if not isinstance(text, str) or not text.strip():
        raise ValueError('Enter text to generate speech.')
    if len(text) > MAX_TEXT_CHARACTERS:
        raise ValueError(f'Text exceeds {MAX_TEXT_CHARACTERS:,} characters.')
    if minimum is None:
        minimum = max(1, int(maximum * 0.75))
    if not 1 <= minimum <= maximum <= 3000:
        raise ValueError('Chunk limits must satisfy 1 <= minimum <= maximum <= 3000.')
    if any(0xD800 <= ord(char) <= 0xDFFF for char in text):
        raise ValueError('Text contains an invalid Unicode surrogate.')
    chunks, start = [], 0
    while start < len(text):
        end, units = start, 0
        candidates = {'paragraph': [], 'sentence': [], 'space': []}
        while end < len(text):
            size = 2 if ord(text[end]) > 0xFFFF else 1
            if units + size > maximum:
                break
            units += size
            end += 1
            if units >= minimum:
                char = text[end - 1]
                if char == '\n':
                    candidates['paragraph'].append(end)
                elif char in '。！？!?．.':
                    # Keep a closing Japanese quote with the sentence if possible.
                    if end == len(text) or text[end] not in '」』”’）)':
                        candidates['sentence'].append(end)
                elif char in '」』”’）)' and end >= 2 and text[end - 2] in '。！？!?．.':
                    candidates['sentence'].append(end)
                elif char.isspace():
                    candidates['space'].append(end)
        if end != len(text):
            for kind in ('paragraph', 'sentence', 'space'):
                if candidates[kind]:
                    end = candidates[kind][-1]
                    break
        # maximum >= 1 may not fit an astral codepoint; default maximum is 3000.
        if end == start:
            raise ValueError('Chunk limit is too small for a Unicode character.')
        part = text[start:end]
        chunks.append({'index': len(chunks) + 1, 'start': start, 'end': end,
                       'text': part, 'characters': len(part), 'utf16_length': utf16_length(part)})
        start = end
    return chunks


class ElevenLabsBridge:
    def __init__(self, store=None, output=None):
        self.store = Path(store or BASE_DIR / 'elevenlabs_jobs.db')
        self.output = Path(output or OUTPUT_DIR / 'elevenlabs')
        self.peer = None
        self.page = {}
        self.enabled = False
        self.ready = False
        self.auto_prepare_tab = False
        self.project_urls = False
        self.tab_id = None
        self.remote_busy = False
        self.remote_state = 'DISCONNECTED'
        self.progress = {}
        self.pending = {}
        self.active = None
        self.inspect_lock = asyncio.Lock()

    @contextmanager
    def db(self):
        self.store.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.store, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.executescript('''
            CREATE TABLE IF NOT EXISTS eleven_settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS eleven_jobs (
              id TEXT PRIMARY KEY, title TEXT NOT NULL, text TEXT NOT NULL, model TEXT NOT NULL,
              state TEXT NOT NULL, error TEXT, merged_file TEXT, merge_error TEXT,
              created REAL NOT NULL, updated REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS eleven_chunks (
              job_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, start_offset INTEGER NOT NULL,
              end_offset INTEGER NOT NULL, text TEXT NOT NULL, utf16_length INTEGER NOT NULL,
              state TEXT NOT NULL, request_id TEXT, audio_file TEXT, metadata TEXT, error TEXT,
              updated REAL NOT NULL, PRIMARY KEY(job_id,chunk_index));
        ''')
        scope.initialize(connection)
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def settings(self):
        with self.db() as connection:
            row = connection.execute('SELECT value FROM eleven_settings WHERE id=1').fetchone()
        return {'paused': False, 'needs_review': False, 'timeout_seconds': 600,
                **(json.loads(row['value']) if row else {})}

    def configure(self, **values):
        current = {**self.settings(), **values}
        with self.db() as connection:
            connection.execute('INSERT OR REPLACE INTO eleven_settings VALUES(1,?)', (json.dumps(current),))
        return current

    def recover(self):
        with self.db() as connection:
            running_jobs = {row['id'] for row in connection.execute("SELECT id FROM eleven_jobs WHERE state='RUNNING'")}
            running_jobs.update(row['job_id'] for row in connection.execute("SELECT job_id FROM eleven_chunks WHERE state='RUNNING'"))
            count = connection.execute("UPDATE eleven_chunks SET state='NEEDS_REVIEW',error=?,updated=? WHERE state='RUNNING'",
              ('Backend restarted during generation. Review the page before retrying; credits may have been used.', time.time())).rowcount
            if count:
                connection.execute("UPDATE eleven_jobs SET state='NEEDS_REVIEW',error=?,updated=? WHERE state='RUNNING'",
                  ('Interrupted generation requires review.', time.time()))
        for jid in running_jobs:
            self._finish_job(jid)
        if count or running_jobs:
            # Includes crash after the audio DB commit but before the browser ACK.
            self.configure(paused=True, needs_review=True)
        return max(count, len(running_jobs))

    def preview(self, text, max_chunk_characters=3000):
        chunks = split_text(text, maximum=max_chunk_characters)
        return {'chunks': chunks, 'total_chunks': len(chunks), 'characters': len(text),
                'utf16_length': utf16_length(text), 'credit_estimate': None,
                'note': 'Credits are optional page information. Missing values do not block generation.'}

    def enqueue(self, text, title='', model=DEFAULT_MODEL, max_chunk_characters=3000, context=None, project_settings=None):
        chunks = split_text(text, maximum=max_chunk_characters)
        model = model.strip() or DEFAULT_MODEL
        if len(model) > 100:
            raise ValueError('Model name is too long.')
        jid, now = str(uuid.uuid4()), time.time()
        with self.db() as connection:
            connection.execute('INSERT INTO eleven_jobs(id,title,text,model,state,created,updated) VALUES(?,?,?,?,?,?,?)',
              (jid, title.strip()[:200] or 'Untitled speech', text, model, 'QUEUED', now, now))
            connection.executemany('''INSERT INTO eleven_chunks(job_id,chunk_index,start_offset,end_offset,text,utf16_length,state,updated)
              VALUES(?,?,?,?,?,?,?,?)''', [(jid, p['index'], p['start'], p['end'], p['text'], p['utf16_length'], 'QUEUED', now) for p in chunks])
            scope.record(connection, 'elevenlabs', jid, context)
            scope.save_settings(connection, 'elevenlabs', jid, project_settings)
        return self.job(jid)

    def _public_job(self, row, chunks):
        data = dict(row)
        data.pop('text', None)
        filename = data.pop('merged_file', None)
        data['merged_url'] = f"/api/elevenlabs/audio/{data['id']}/merged" if filename else None
        data['retry_requires_review'] = any(chunk['state'] in ('NEEDS_REVIEW', 'CANCELLED') for chunk in chunks)
        data['recoverable_downloads'] = sum(chunk['state'] != 'COMPLETED' and
            isinstance(json.loads(chunk['metadata'] or '{}').get('nativeDownload'), dict) for chunk in chunks)
        return data

    def jobs(self, filters=None):
        where, params = scope.job_filter('elevenlabs', 'j.id', filters)
        with self.db() as connection:
            rows = connection.execute(f'''SELECT j.*,length(j.text) characters,
              count(c.chunk_index) total_chunks,sum(c.state='COMPLETED') completed_chunks
              FROM eleven_jobs j LEFT JOIN eleven_chunks c ON j.id=c.job_id {where} GROUP BY j.id ORDER BY j.created DESC LIMIT 500''', params).fetchall()
            parts = {row['id']: [] for row in rows}
            if rows:
                markers = ','.join('?' for _ in rows)
                for chunk in connection.execute(f'SELECT job_id,state,metadata FROM eleven_chunks WHERE job_id IN ({markers})', list(parts)):
                    parts[chunk['job_id']].append(chunk)
            return [self._public_job(row, parts[row['id']]) for row in rows]

    def job(self, jid):
        with self.db() as connection:
            row = connection.execute('''SELECT j.*,length(j.text) characters,count(c.chunk_index) total_chunks,
              sum(c.state='COMPLETED') completed_chunks FROM eleven_jobs j LEFT JOIN eleven_chunks c ON j.id=c.job_id
              WHERE j.id=? GROUP BY j.id''', (jid,)).fetchone()
            if not row:
                raise KeyError(jid)
            chunks = connection.execute('SELECT * FROM eleven_chunks WHERE job_id=? ORDER BY chunk_index', (jid,)).fetchall()
            result = self._public_job(row, chunks)
            result['text'] = row['text']
            result['chunks'] = []
            for chunk in chunks:
                part = dict(chunk)
                part['index'] = part.pop('chunk_index')
                part['start'] = part.pop('start_offset')
                part['end'] = part.pop('end_offset')
                part['characters'] = len(part['text'])
                part['metadata'] = json.loads(part['metadata']) if part['metadata'] else {}
                part['recoverable_download'] = part['state'] != 'COMPLETED' and isinstance(part['metadata'].get('nativeDownload'), dict)
                filename = part.pop('audio_file')
                part['audio_url'] = f"/api/elevenlabs/audio/{jid}/{part['index']}" if filename else None
                result['chunks'].append(part)
        return result

    def status(self):
        settings = self.settings()
        review = settings['needs_review'] or self.remote_state == 'NEEDS_REVIEW'
        processing = self.active is not None or (self.remote_busy and self.remote_state not in ('NEEDS_REVIEW', 'DISCONNECTED', 'CONNECTING'))
        return {'service': 'flowkit-elevenlabs-bridge', 'protocol': 1,
                'connected': self.peer is not None, 'extensionConnected': self.peer is not None,
                'enabled': self.enabled, 'ready': self.ready, 'tabId': self.tab_id, 'busy': processing,
                'autoPrepareTab': self.auto_prepare_tab,
                'processing': processing, 'reviewRequired': review, 'blocked': review or settings['paused'],
                'state': self.remote_state, 'settings': settings, 'page': self.page,
                'progress': self.progress, 'needsReview': review,
                'active': dict(self.active) if self.active else None}

    def cancel(self, jid):
        self.job(jid)
        with self.db() as connection:
            count = connection.execute("UPDATE eleven_chunks SET state='CANCELLED',updated=? WHERE job_id=? AND state='QUEUED'", (time.time(), jid)).rowcount
        self._finish_job(jid)
        return {'cancelled': count, 'active_continues': bool(self.active and self.active['job_id'] == jid)}

    def retry(self, jid, reviewed=False):
        current = self.job(jid)
        if not reviewed and (current['retry_requires_review'] or current['state'] != 'FAILED'):
            raise BridgeError('Confirm that you reviewed the page. Retrying may use credits again.')
        if self.active or self.inspect_lock.locked():
            raise BridgeError('Wait for the active chunk to finish.')
        if self.settings()['needs_review']:
            raise BridgeError('Use Review & unlock before retrying this job.')
        with self.db() as connection:
            count = connection.execute("UPDATE eleven_chunks SET state='QUEUED',request_id=NULL,error=NULL,updated=? WHERE job_id=? AND state IN ('NEEDS_REVIEW','FAILED','CANCELLED')", (time.time(), jid)).rowcount
            if count:
                connection.execute("UPDATE eleven_jobs SET state='QUEUED',error=NULL,updated=? WHERE id=?", (time.time(), jid))
        return {'queued': count, 'job': self.job(jid)}

    async def connect(self, peer):
        if self.peer is not None:
            raise BridgeError('An ElevenLabs extension is already connected.')
        self.peer = peer
        self.enabled = False
        self.ready = False
        self.auto_prepare_tab = False
        self.project_urls = False
        self.tab_id = None
        self.remote_state = 'CONNECTING'
        self.remote_busy = False
        self.page = {}

    async def disconnect(self, peer):
        if self.peer is not peer:
            return
        self.peer, self.enabled = None, False
        self.ready = False
        self.auto_prepare_tab = False
        self.project_urls = False
        self.tab_id = None
        self.remote_state = 'DISCONNECTED'
        self.remote_busy = False
        for rid, (owner, future, _) in list(self.pending.items()):
            if owner is peer and not future.done():
                future.set_exception(BridgeError('Extension disconnected. Review the page before retrying.'))

    async def receive(self, peer, message):
        if peer is not self.peer or not isinstance(message, dict):
            return
        kind = message.get('type')
        if kind in ('status', 'hello'):
            self.enabled = message.get('enabled') is True
            candidate_tab = message.get('tabId')
            self.tab_id = candidate_tab if type(candidate_tab) is int and candidate_tab >= 0 else None
            # Fresh-tab workers create and bind their own tab after dispatch.
            # Older workers must still have a valid bound tab before claiming a job.
            self.auto_prepare_tab = message.get('autoPrepareTab') is True
            self.project_urls = message.get('projectUrls') is True
            self.ready = message.get('ready') is True and (self.tab_id is not None or self.auto_prepare_tab)
            self.remote_busy = message.get('busy') is True
            self.remote_state = str(message.get('state') or ('BUSY' if self.remote_busy else 'IDLE'))[:80]
            page = message.get('page')
            if isinstance(page, dict):
                self.page = page
            if self.remote_state == 'NEEDS_REVIEW':
                self.configure(paused=True, needs_review=True)
            return
        rid = message.get('requestId')
        if not isinstance(rid, str):
            return
        pending = self.pending.get(rid)
        if not pending or pending[0] is not peer:
            return  # Includes stale results from a disconnected browser/session.
        if kind == 'progress' and self.active and self.active.get('request_id') == rid:
            self.progress = {'requestId': rid, 'phase': str(message.get('phase', ''))[:100],
                             'message': str(message.get('message', ''))[:300], 'updated': time.time()}
        elif kind == pending[2] and not pending[1].done():
            pending[1].set_result(message)

    async def request(self, kind, payload=None, timeout=30, request_id=None, expected='result', peer=None):
        peer = peer or self.peer
        if peer is None or peer is not self.peer:
            raise BridgeError('ElevenLabs extension is not connected.')
        rid = request_id or str(uuid.uuid4())
        future = asyncio.get_running_loop().create_future()
        if rid in self.pending:
            raise BridgeError('Duplicate bridge request ID.')
        self.pending[rid] = (peer, future, expected)
        try:
            await peer.send_json({'type': kind, 'requestId': rid, **(payload or {})})
            return await asyncio.wait_for(future, timeout)
        finally:
            self.pending.pop(rid, None)

    async def probe(self):
        async with self.inspect_lock:
            if self.active:
                raise BridgeError('Wait for the active chunk before checking the page.')
            result = await self.request('probe')
            if not result.get('ok'):
                raise BridgeError(result.get('error') or 'ElevenLabs page check failed.')
            if isinstance(result.get('page'), dict):
                self.page = result['page']
            return result

    async def control(self, action, reviewed=False):
        if action == 'pause':
            self.configure(paused=True)
        elif action == 'resume':
            if self.settings()['needs_review']:
                raise BridgeError('Review & unlock the browser before resuming.')
            self.configure(paused=False)
        elif action == 'review':
            if not reviewed:
                raise BridgeError('Confirm that you reviewed the page and any completed audio first.')
            async with self.inspect_lock:
                if self.active:
                    raise BridgeError('Wait for the active chunk to finish.')
                result = await self.request('review')
                if not result.get('ok'):
                    raise BridgeError(result.get('error') or 'Page is not ready to unlock.')
                self.configure(needs_review=False, paused=True)
                # The explicit review result is authoritative. Do not wait for a
                # later heartbeat to clear a stale busy/review status in Desktop.
                self.remote_busy = False
                self.remote_state = 'IDLE'
                self.progress = {}
                if isinstance(result.get('page'), dict):
                    self.page = result['page']
        else:
            raise ValueError('Unknown queue action.')
        return self.status()

    async def recover_downloads(self, jid, reviewed=False):
        """Import previously downloaded files without sending another Generate."""
        if not reviewed:
            raise BridgeError('Confirm that you reviewed the downloaded audio before recovering it.')
        async with self.inspect_lock:
            if self.active:
                raise BridgeError('Wait for the active chunk to finish.')
            if self.settings()['needs_review'] or self.remote_state == 'NEEDS_REVIEW':
                raise BridgeError('Release the worker after review before recovering downloaded audio.')
            job = self.job(jid)
            self.configure(paused=True)
            recovered, errors = 0, []
            for chunk in job['chunks']:
                if not chunk['recoverable_download']:
                    continue
                metadata = chunk['metadata']
                writer = asyncio.create_task(asyncio.to_thread(self._save_audio, jid, chunk['index'], metadata))
                interrupted = False
                try:
                    try:
                        filename = await asyncio.shield(writer)
                    except asyncio.CancelledError:
                        filename = await writer
                        interrupted = True
                    with self.db() as connection:
                        connection.execute("UPDATE eleven_chunks SET state='COMPLETED',audio_file=?,error=NULL,updated=? WHERE job_id=? AND chunk_index=?",
                                           (filename, time.time(), jid, chunk['index']))
                    recovered += 1
                    if interrupted:
                        raise asyncio.CancelledError()
                except Exception as error:
                    errors.append({'chunk_index': chunk['index'], 'error': str(error)[:1000]})
                    with self.db() as connection:
                        connection.execute('UPDATE eleven_chunks SET error=?,updated=? WHERE job_id=? AND chunk_index=?',
                                           (str(error)[:1000], time.time(), jid, chunk['index']))
                finally:
                    self._finish_job(jid)
            current = self.job(jid)
            if recovered:
                with self.db() as connection:
                    remaining_error = next((chunk['error'] for chunk in current['chunks'] if chunk['error']), None)
                    connection.execute('UPDATE eleven_jobs SET error=?,updated=? WHERE id=?', (remaining_error, time.time(), jid))
            if current['state'] == 'COMPLETED':
                await asyncio.to_thread(self._merge_audio, jid)
            return {'recovered': recovered, 'errors': errors, 'job': self.job(jid)}

    def audio_path(self, jid, index):
        # Never interpret request-controlled filenames or paths.
        with self.db() as connection:
            if index == 'merged':
                row = connection.execute('SELECT merged_file audio_file FROM eleven_jobs WHERE id=?', (jid,)).fetchone()
            else:
                try:
                    number = int(index)
                except (ValueError, TypeError):
                    raise KeyError(index) from None
                row = connection.execute("SELECT audio_file FROM eleven_chunks WHERE job_id=? AND chunk_index=? AND state='COMPLETED'", (jid, number)).fetchone()
        if not row or not row['audio_file']:
            raise KeyError(index)
        path = (self.output / jid / row['audio_file']).resolve()
        if not path.is_relative_to(self.output.resolve()) or not path.is_file():
            raise KeyError(index)
        return path

    def _save_audio(self, jid, index, result):
        native = result.get('nativeDownload')
        source = None
        if native is not None:
            if not isinstance(native, dict) or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', str(native.get('token', ''))):
                raise ValueError('Invalid browser download identifier.')
            root = Path(os.environ.get('ELEVENLABS_DOWNLOAD_DIR') or Path.home() / 'Downloads').expanduser().resolve()
            source = root / 'flowkit-elevenlabs' / native['token'] / 'audio.mp3'
            supplied = native.get('path')
            if not isinstance(supplied, str) or Path(supplied).resolve() != source or source.resolve() != source:
                raise ValueError('Browser download location does not match the configured Downloads folder. Set ELEVENLABS_DOWNLOAD_DIR to Chrome download location and restart Studio. Recover this audio without generating it again.')
            if not source.is_file():
                raise ValueError('Browser audio file is missing.')
            with source.open('rb') as handle:
                data = handle.read(64)
            if data.startswith(b'RIFF') and data[8:12] == b'WAVE':
                mime = 'audio/wav'
            elif data.startswith(b'OggS'):
                mime = 'audio/ogg'
            elif data.startswith(b'fLaC'):
                mime = 'audio/flac'
            elif data[4:8] == b'ftyp':
                mime = 'audio/mp4'
            else:
                mime = 'audio/mpeg'
        else:
            encoded = result.get('audioBase64')
            if not isinstance(encoded, str):
                raise ValueError('Audio result has neither a browser download path nor audio bytes. Update both the backend and extension, then restart Studio.')
            if len(encoded) > ((MAX_AUDIO_BYTES + 2) // 3) * 4:
                raise ValueError('Legacy WebSocket audio payload exceeds the 10 MiB limit. Update the extension to use browser downloads.')
            try:
                data = base64.b64decode(encoded, validate=True)
            except (binascii.Error, ValueError) as error:
                raise ValueError('Invalid base64 audio payload.') from error
            mime = str(result.get('mimeType', '')).split(';')[0].lower()
        if not data:
            raise ValueError('Audio file is empty.')
        if source is None and len(data) > MAX_AUDIO_BYTES:
            raise ValueError('Legacy WebSocket audio payload exceeds the 10 MiB limit. Use browser downloads.')
        extensions = {'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav',
                      'audio/ogg': '.ogg', 'audio/flac': '.flac', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a'}
        ext = extensions.get(mime)
        if not ext:
            raise ValueError('Unsupported audio MIME type.')
        valid_magic = ((ext == '.mp3' and (data.startswith(b'ID3') or (len(data) > 1 and data[0] == 255 and data[1] & 224 == 224)))
            or (ext == '.wav' and data.startswith(b'RIFF') and data[8:12] == b'WAVE')
            or (ext == '.ogg' and data.startswith(b'OggS')) or (ext == '.flac' and data.startswith(b'fLaC'))
            or (ext == '.m4a' and data[4:8] == b'ftyp'))
        if not valid_magic:
            raise ValueError('Downloaded data is not the declared audio format.')
        directory = self.output / jid
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / f'{index:03d}{ext}'
        temporary = directory / f'{index:03d}.{uuid.uuid4().hex}.part{ext}'
        try:
            with temporary.open('xb') as handle:
                if source is not None:
                    with source.open('rb') as downloaded:
                        shutil.copyfileobj(downloaded, handle, length=1024 * 1024)
                else:
                    handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            probe = shutil.which('ffprobe')
            if probe:
                process = subprocess.run([probe, '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type',
                                          '-of', 'json', str(temporary)], capture_output=True, timeout=25, check=False)
                parsed = json.loads(process.stdout or b'{}')
                if process.returncode or not any(s.get('codec_type') == 'audio' for s in parsed.get('streams', [])):
                    raise ValueError('FFprobe could not validate the downloaded audio.')
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
        return target.name

    def _finish_job(self, jid):
        with self.db() as connection:
            states = [row['state'] for row in connection.execute('SELECT state FROM eleven_chunks WHERE job_id=?', (jid,))]
            state = ('NEEDS_REVIEW' if 'NEEDS_REVIEW' in states else 'RUNNING' if 'RUNNING' in states else
                     'FAILED' if 'FAILED' in states else 'QUEUED' if 'QUEUED' in states else 'CANCELLED' if 'CANCELLED' in states else 'COMPLETED')
            connection.execute('UPDATE eleven_jobs SET state=?,updated=? WHERE id=?', (state, time.time(), jid))
        return state

    def _merge_audio(self, jid):
        """Optional local merge; generation remains completed if FFmpeg is absent/fails."""
        with self.db() as connection:
            rows = connection.execute('SELECT audio_file FROM eleven_chunks WHERE job_id=? ORDER BY chunk_index', (jid,)).fetchall()
        directory = self.output / jid
        if len(rows) == 1:
            with self.db() as connection:
                connection.execute('UPDATE eleven_jobs SET merged_file=? WHERE id=?', (rows[0]['audio_file'], jid))
            return
        ffmpeg = shutil.which('ffmpeg')
        if not ffmpeg:
            with self.db() as connection:
                connection.execute('UPDATE eleven_jobs SET merge_error=? WHERE id=?',
                                   ('FFmpeg is not installed. Individual chunk audio is still available.', jid))
            return
        listing, temporary, target = directory / 'concat.txt', directory / 'merged.part.mp3', directory / 'merged.mp3'
        try:
            # Audio filenames are generated internally, never supplied by the extension.
            listing.write_text(''.join(f"file '{row['audio_file']}'\n" for row in rows), encoding='utf-8')
            process = subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '1',
              '-i', str(listing), '-vn', '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '192k', str(temporary)],
              capture_output=True, timeout=180, check=False)
            if process.returncode or not temporary.is_file() or temporary.stat().st_size == 0:
                raise ValueError('FFmpeg could not merge this job. Individual chunk audio is still available.')
            os.replace(temporary, target)
            with self.db() as connection:
                connection.execute('UPDATE eleven_jobs SET merged_file=?,merge_error=NULL WHERE id=?', (target.name, jid))
        except Exception as error:
            with self.db() as connection:
                connection.execute('UPDATE eleven_jobs SET merge_error=? WHERE id=?', (str(error)[:500], jid))
        finally:
            listing.unlink(missing_ok=True)
            temporary.unlink(missing_ok=True)

    async def step(self):
        settings = self.settings()
        if (self.active or self.inspect_lock.locked() or settings['paused'] or settings['needs_review']
            or self.peer is None or not self.enabled or not self.ready or self.remote_busy or self.remote_state != 'IDLE'):
            return False
        peer = self.peer
        rid = str(uuid.uuid4())
        with self.db() as connection:
            row = connection.execute('''SELECT c.*,j.model FROM eleven_chunks c JOIN eleven_jobs j ON j.id=c.job_id
              WHERE c.state='QUEUED' AND j.state IN ('QUEUED','RUNNING') ORDER BY j.created,c.chunk_index LIMIT 1''').fetchone()
            if not row:
                return False
            job = dict(row)
            previous = connection.execute("SELECT metadata FROM eleven_chunks WHERE job_id=? AND state='COMPLETED' ORDER BY chunk_index LIMIT 1", (job['job_id'],)).fetchone()
            expected_voice = (json.loads(previous['metadata'] or '{}').get('voice') if previous else None)
            connection.execute("UPDATE eleven_chunks SET state='RUNNING',request_id=?,updated=? WHERE job_id=? AND chunk_index=?", (rid, time.time(), job['job_id'], job['chunk_index']))
            connection.execute("UPDATE eleven_jobs SET state='RUNNING',error=NULL,updated=? WHERE id=?", (time.time(), job['job_id']))
        self.active = {'job_id': job['job_id'], 'chunk_index': job['chunk_index'], 'request_id': rid}
        self.progress = {'requestId': rid, 'phase': 'DISPATCHING', 'updated': time.time()}
        saved = False
        not_submitted = False
        remote_locked = False
        try:
            page_url = scope.load_settings(self,'elevenlabs',job['job_id']).get('elevenlabs_url')
            if page_url and not self.project_urls:
                not_submitted=True
                raise BridgeError('Reload the updated ElevenLabs extension for project URLs. No speech was generated.')
            result = await self.request('generate', {**({'pageUrl':page_url} if page_url else {}), 'text': job['text'], 'model': job['model'],
                       'expectedVoice': expected_voice, 'timeout': settings['timeout_seconds'] * 1000}, timeout=settings['timeout_seconds'] + 240, request_id=rid, peer=peer)
            if not result.get('ok'):
                not_submitted = result.get('notSubmitted') is True
                remote_locked = (result.get('needsReview') is True or
                                 result.get('state') in ('NEEDS_REVIEW', 'AWAITING_SAVE', 'RUNNING'))
                raise BridgeError(str(result.get('error') or 'ElevenLabs generation failed.'))
            metadata = {key: result[key] for key in ('creditsBefore','creditsAfter','estimatedCost','creditCheck',
                        'creditsApproximate','voice','model','mimeType','nativeDownload') if key in result}
            # Record the downloaded file before importing it. A wrong download
            # directory, disk error or restart must not force paid regeneration.
            with self.db() as connection:
                connection.execute('UPDATE eleven_chunks SET metadata=?,updated=? WHERE job_id=? AND chunk_index=?',
                                   (json.dumps(metadata), time.time(), job['job_id'], job['chunk_index']))
            self.progress = {'requestId': rid, 'phase': 'SAVING_AUDIO', 'updated': time.time()}
            # Keep the API event loop responsive while FFprobe validates the file.
            # On shutdown, finish the atomic writer and record it before cancellation.
            writer = asyncio.create_task(asyncio.to_thread(self._save_audio, job['job_id'], job['chunk_index'], result))
            interrupted = False
            try:
                filename = await asyncio.shield(writer)
            except asyncio.CancelledError:
                filename = await writer
                interrupted = True
            with self.db() as connection:
                connection.execute("UPDATE eleven_chunks SET state='COMPLETED',audio_file=?,metadata=?,error=NULL,updated=? WHERE job_id=? AND chunk_index=?", (filename, json.dumps(metadata), time.time(), job['job_id'], job['chunk_index']))
                job_complete = connection.execute(
                    "SELECT COUNT(*) FROM eleven_chunks WHERE job_id=? AND state!='COMPLETED'",
                    (job['job_id'],),
                ).fetchone()[0] == 0
            saved = True
            if interrupted:
                raise asyncio.CancelledError()
            ack = await self.request('commit', {'ok': True, 'jobComplete': job_complete}, timeout=10, request_id=rid, expected='commitAck', peer=peer)
            if not ack.get('ok'):
                raise BridgeError('Extension did not confirm the saved audio. Review before continuing.')
            self.remote_busy = False
            self.remote_state = 'IDLE'
        except BaseException as error:
            message = ('Backend stopped during generation.' if isinstance(error, asyncio.CancelledError) else str(error)) or 'Bridge operation timed out.'
            needs_review = not not_submitted or remote_locked or self.remote_state == 'NEEDS_REVIEW'
            self.configure(paused=True, needs_review=needs_review)
            if not_submitted and not needs_review:
                self.remote_busy = False
                self.remote_state = 'IDLE'
            self.progress = {'requestId': rid, 'phase': 'NEEDS_REVIEW' if needs_review else 'FAILED',
                             'message': message[:300], 'updated': time.time()}
            with self.db() as connection:
                if not saved:
                    connection.execute('UPDATE eleven_chunks SET state=?,error=?,updated=? WHERE job_id=? AND chunk_index=?',
                                       ('FAILED' if not_submitted else 'NEEDS_REVIEW', message[:1000], time.time(), job['job_id'], job['chunk_index']))
                connection.execute('UPDATE eleven_jobs SET error=?,updated=? WHERE id=?', (message[:1000], time.time(), job['job_id']))
            if not saved and not not_submitted and peer is self.peer:
                try:
                    await peer.send_json({'type': 'commit', 'requestId': rid, 'ok': False})
                except Exception:
                    pass
            if isinstance(error, (asyncio.CancelledError, KeyboardInterrupt, SystemExit)):
                raise
        finally:
            self.active = None
            state = self._finish_job(job['job_id'])
        if state == 'COMPLETED':
            await asyncio.to_thread(self._merge_audio, job['job_id'])
        return True

    async def run(self):
        self.recover()
        while True:
            await self.step()
            await asyncio.sleep(0.5)


bridge = ElevenLabsBridge()


async def run():
    await bridge.run()
