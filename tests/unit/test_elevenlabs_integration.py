"""Real local HTTP/WebSocket contract with fake provider and valid generated audio."""
import asyncio
import base64
from contextlib import asynccontextmanager
import io
import math
import shutil
import struct
import time
import wave
import uuid
import pytest

from fastapi import FastAPI
from fastapi.testclient import TestClient

from agent.api import elevenlabs as api
from agent.services.elevenlabs_bridge import ElevenLabsBridge


@pytest.mark.parametrize("native", [False, True])
@pytest.mark.parametrize("fresh_tab", [False, True])
def test_http_ws_queue_persists_two_audio_chunks_before_ack(tmp_path, monkeypatch, native, fresh_tab):
    monkeypatch.setenv("ELEVENLABS_DOWNLOAD_DIR", str(tmp_path / "Downloads"))
    service = ElevenLabsBridge(tmp_path / 'jobs.db', tmp_path / 'audio')
    monkeypatch.setattr(api, 'bridge', service)

    @asynccontextmanager
    async def lifespan(_):
        task = asyncio.create_task(service.run())
        try:
            yield
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    app = FastAPI(lifespan=lifespan)
    app.include_router(api.router, prefix='/api')
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(16000)
        out.writeframes(b''.join(struct.pack('<h', int(2000 * math.sin(2 * math.pi * 440 * i / 16000))) for i in range(1600)))
    audio = buf.getvalue()
    origin = 'chrome-extension://' + 'a' * 32
    with TestClient(app, client=('127.0.0.1', 50000)) as client:
        with client.websocket_connect('/api/elevenlabs/ws', headers={'origin': origin}) as ws:
            ws.send_json({'type': 'status', 'enabled': True, 'ready': True, 'busy': False, 'state': 'IDLE',
                          'tabId': None if fresh_tab else 9, 'autoPrepareTab': fresh_tab,
                          'page': {'model': 'Eleven v4', 'voice': 'Test voice', 'credits': 20000}})
            response = client.post('/api/elevenlabs/jobs', json={'title': 'Japanese test', 'text': '日本語の文章です。' * 220})
            assert response.status_code == 200
            job = response.json()
            assert job['total_chunks'] == 2
            for index in (1, 2):
                command = ws.receive_json()
                assert command['type'] == 'generate'
                assert len(command['text']) < 1200
                assert command['model'] == 'Eleven v4'
                assert command['expectedVoice'] == ('Test voice' if index == 2 else None)
                ws.send_json({'type': 'progress', 'requestId': command['requestId'], 'phase': 'GENERATING'})
                payload = {'audioBase64': base64.b64encode(audio).decode(), 'mimeType': 'audio/wav'}
                if native:
                    token = str(uuid.uuid4())
                    downloaded = tmp_path / 'Downloads' / 'flowkit-elevenlabs' / token / 'audio.mp3'
                    downloaded.parent.mkdir(parents=True)
                    downloaded.write_bytes(audio)
                    payload = {'nativeDownload': {'token': token, 'path': str(downloaded)}}
                ws.send_json({'type': 'result', 'requestId': command['requestId'], 'ok': True,
                              **payload,
                              'voice': 'Test voice', 'model': 'Eleven v4', 'creditsBefore': 20000,
                              'creditsAfter': 15000, 'estimatedCost': None})
                commit = ws.receive_json()
                assert commit == {'type': 'commit', 'requestId': command['requestId'], 'ok': True}
                detail = client.get('/api/elevenlabs/jobs/' + job['id']).json()
                chunk = detail['chunks'][index - 1]
                assert chunk['state'] == 'COMPLETED'
                assert client.get(chunk['audio_url']).content == audio
                assert service.audio_path(job['id'], index).name == f'{index:03}.wav'
                ws.send_json({'type': 'commitAck', 'requestId': command['requestId'], 'ok': True})
            for _ in range(100):
                detail = client.get('/api/elevenlabs/jobs/' + job['id']).json()
                if detail['state'] == 'COMPLETED' and (detail['merged_url'] or not shutil.which('ffmpeg')):
                    break
                time.sleep(0.05)
            assert detail['completed_chunks'] == 2
            assert detail['state'] == 'COMPLETED'
            if shutil.which('ffmpeg'):
                assert detail['merged_url']
                assert len(client.get(detail['merged_url']).content) > 0


def test_browser_origin_cannot_enqueue_paid_jobs(monkeypatch):
    from agent.main import app
    def forbidden(*args, **kwargs):
        raise AssertionError('Browser request must not reach paid job queue')
    monkeypatch.setattr(api.bridge, 'enqueue', forbidden)
    client = TestClient(app)
    for origin in ('https://example.com', 'null'):
        r = client.post('/api/elevenlabs/jobs', headers={'origin': origin}, json={'text': 'Do not submit'})
        assert r.status_code == 403


def test_http_recovers_existing_download_without_connected_extension_or_generation(tmp_path, monkeypatch):
    import json
    root = tmp_path / 'Downloads'
    monkeypatch.setenv('ELEVENLABS_DOWNLOAD_DIR', str(root))
    service = ElevenLabsBridge(tmp_path / 'jobs.db', tmp_path / 'audio')
    monkeypatch.setattr(api, 'bridge', service)
    job = service.enqueue('Already generated and downloaded.')
    token = str(uuid.uuid4())
    source = root / 'flowkit-elevenlabs' / token / 'audio.mp3'
    source.parent.mkdir(parents=True)
    with wave.open(str(source), 'wb') as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(8000)
        out.writeframes(b'\0\0' * 800)
    metadata = {'nativeDownload': {'token': token, 'path': str(source)}, 'voice': 'Test voice'}
    with service.db() as connection:
        connection.execute("UPDATE eleven_chunks SET state='NEEDS_REVIEW',metadata=? WHERE job_id=?", (json.dumps(metadata), job['id']))
    service._finish_job(job['id'])
    app = FastAPI()
    app.include_router(api.router, prefix='/api')
    with TestClient(app) as client:
        endpoint = '/api/elevenlabs/jobs/' + job['id'] + '/recover'
        assert client.post(endpoint, json={}).status_code == 409
        response = client.post(endpoint, json={'reviewed': True})
        assert response.status_code == 200
        recovered = response.json()
        assert recovered['recovered'] == 1
        assert not recovered['errors']
        assert recovered['job']['state'] == 'COMPLETED'
        assert client.get(recovered['job']['chunks'][0]['audio_url']).content == source.read_bytes()
        assert service.peer is None and service.settings()['paused']
        assert client.post('/api/elevenlabs/jobs/missing/recover', json={'reviewed': True}).status_code == 404
