import asyncio
import base64
import io
from types import SimpleNamespace
import wave
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from agent.services import elevenlabs_bridge as module
from agent.services.elevenlabs_bridge import ElevenLabsBridge, BridgeError, split_text, utf16_length
from agent.api import elevenlabs as api


@pytest.fixture
def bridge(tmp_path):
    return ElevenLabsBridge(tmp_path / 'eleven.db', tmp_path / 'audio')


def wav_payload():
    data = io.BytesIO()
    with wave.open(data, 'wb') as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(8000)
        handle.writeframes(b'\0\0' * 800)
    return base64.b64encode(data.getvalue()).decode('ascii')


class Peer:
    def __init__(self, bridge, response=None, drop_commit=False):
        self.bridge, self.sent, self.response, self.drop_commit = bridge, [], response, drop_commit

    async def send_json(self, message):
        self.sent.append(message)
        rid, kind = message['requestId'], message['type']
        if kind == 'generate':
            response = self.response or {'ok': True, 'audioBase64': wav_payload(), 'mimeType': 'audio/wav', 'model': 'Eleven v4', 'estimatedCost': None}
            await self.bridge.receive(self, {'type': 'result', 'requestId': rid, **response})
        elif kind == 'commit' and message['ok']:
            active = self.bridge.active
            job = self.bridge.job(active['job_id'])
            chunk = job['chunks'][active['chunk_index'] - 1]
            assert chunk['state'] == 'COMPLETED'
            assert self.bridge.audio_path(job['id'], active['chunk_index']).read_bytes()
            if self.drop_commit:
                await self.bridge.disconnect(self)
            else:
                await self.bridge.receive(self, {'type': 'commitAck', 'requestId': rid, 'ok': True})
        elif kind in ('probe', 'review'):
            await self.bridge.receive(self, {'type': 'result', 'requestId': rid, 'ok': True, 'page': {'generating': False}})


async def connected(bridge, **kwargs):
    peer = Peer(bridge, **kwargs)
    await bridge.connect(peer)
    await bridge.receive(peer, {'type': 'status', 'enabled': True, 'ready': True, 'tabId': 7, 'busy': False, 'state': 'IDLE'})
    return peer


def test_japanese_split_is_lossless_with_exact_offsets_and_sentence_boundaries():
    text = ('段落を読みます。これは日本語の文章です。\n' * 700) + '終わり。\n '
    chunks = split_text(text)
    assert ''.join(p['text'] for p in chunks) == text
    assert all(text[p['start']:p['end']] == p['text'] for p in chunks)
    assert all(2250 <= p['utf16_length'] <= 3000 for p in chunks[:-1])
    assert all(p['text'].endswith('\n') for p in chunks[:-1])
    assert chunks[-1]['end'] == len(text)


def test_astral_characters_use_conservative_utf16_cap_and_preserve_tag_text():
    text = '[happy]😀説明' * 1400 + '\r\n [pause] 終了'
    chunks = split_text(text)
    assert ''.join(c['text'] for c in chunks) == text
    assert all(c['utf16_length'] == utf16_length(c['text']) <= 3000 for c in chunks)
    assert all(not any(0xD800 <= ord(ch) <= 0xDFFF for ch in c['text']) for c in chunks)


def test_unbroken_sentence_hard_split_and_short_final_chunk():
    chunks = split_text('あ' * 8100)
    assert [c['characters'] for c in chunks] == [3000, 3000, 2100]


@pytest.mark.parametrize('text', ['', ' \n ', '\ud800', 'あ' * 500001])
def test_invalid_inputs_rejected(text):
    with pytest.raises(ValueError):
        split_text(text)


@pytest.mark.asyncio
async def test_two_chunks_saved_before_commit_and_generated_in_order(bridge, monkeypatch):
    monkeypatch.setattr(bridge, '_merge_audio', lambda jid: None)
    job = bridge.enqueue('一' * 4200)
    peer = await connected(bridge)
    assert await bridge.step()
    assert bridge.job(job['id'])['completed_chunks'] == 1
    assert await bridge.step()
    current = bridge.job(job['id'])
    assert current['state'] == 'COMPLETED'
    assert current['completed_chunks'] == 2
    assert [m['type'] for m in peer.sent] == ['generate', 'commit', 'generate', 'commit']
    assert [m['jobComplete'] for m in peer.sent if m['type'] == 'commit'] == [False, True]
    assert ''.join(m['text'] for m in peer.sent if m['type'] == 'generate') == job['text']
    assert current['chunks'][0]['metadata']['estimatedCost'] is None


@pytest.mark.asyncio
async def test_generation_never_overlaps_even_if_step_called_twice(bridge):
    bridge.enqueue('日本語' * 3000)
    gate = asyncio.Event()
    peer = await connected(bridge)
    original = peer.send_json
    async def send(message):
        if message['type'] == 'generate':
            await gate.wait()
        await original(message)
    peer.send_json = send
    task = asyncio.create_task(bridge.step())
    await asyncio.sleep(0)
    assert bridge.active is not None
    assert await bridge.step() is False
    gate.set()
    await task
    assert len([m for m in peer.sent if m['type'] == 'generate']) == 1


@pytest.mark.asyncio
async def test_proven_pre_submit_failure_pauses_without_review_or_automatic_retry(bridge):
    job = bridge.enqueue('Test')
    peer = await connected(bridge, response={'ok': False, 'error': 'Insufficient credits', 'notSubmitted': True})
    await bridge.step()
    assert bridge.job(job['id'])['state'] == 'FAILED'
    assert not bridge.job(job['id'])['retry_requires_review']
    assert bridge.settings()['paused'] and not bridge.settings()['needs_review']
    assert not bridge.status()['busy']
    assert await bridge.step() is False
    assert len([m for m in peer.sent if m['type'] == 'generate']) == 1
    assert not [m for m in peer.sent if m['type'] == 'commit']
    assert bridge.retry(job['id'])['queued'] == 1
    assert bridge.settings()['paused']


@pytest.mark.asyncio
async def test_ack_disconnect_preserves_audio_and_blocks_next_chunk(bridge):
    job = bridge.enqueue('文' * 4200)
    await connected(bridge, drop_commit=True)
    await bridge.step()
    stored = bridge.job(job['id'])
    assert stored['chunks'][0]['state'] == 'COMPLETED'
    assert bridge.audio_path(job['id'], 1).is_file()
    assert stored['chunks'][1]['state'] == 'QUEUED'
    assert bridge.settings()['needs_review']
    assert await bridge.step() is False


@pytest.mark.asyncio
async def test_result_from_wrong_peer_and_wrong_request_is_ignored(bridge):
    peer = SimpleNamespace(send_json=None)
    sent = []
    async def send(message):
        sent.append(message)
    peer.send_json = send
    await bridge.connect(peer)
    task = asyncio.create_task(bridge.request('probe', timeout=1))
    await asyncio.sleep(0)
    rid = sent[0]['requestId']
    await bridge.receive(object(), {'type': 'result', 'requestId': rid, 'ok': True})
    await bridge.receive(peer, {'type': 'result', 'requestId': 'stale', 'ok': True})
    assert not task.done()
    await bridge.receive(peer, {'type': 'commitAck', 'requestId': rid, 'ok': True})
    assert not task.done()
    await bridge.receive(peer, {'type': 'result', 'requestId': rid, 'ok': True})
    assert (await task)['ok']


def test_restart_quarantines_inflight_and_never_requeues(bridge):
    job = bridge.enqueue('日本語' * 2500)
    with bridge.db() as connection:
        connection.execute("UPDATE eleven_chunks SET state='RUNNING' WHERE job_id=? AND chunk_index=1", (job['id'],))
        connection.execute("UPDATE eleven_jobs SET state='RUNNING' WHERE id=?", (job['id'],))
    restarted = ElevenLabsBridge(bridge.store, bridge.output)
    assert restarted.recover() == 1
    assert restarted.job(job['id'])['chunks'][0]['state'] == 'NEEDS_REVIEW'
    assert restarted.job(job['id'])['chunks'][1]['state'] == 'QUEUED'
    assert restarted.settings()['paused']


@pytest.mark.asyncio
async def test_cancel_and_reviewed_retry_preserve_completed_audio(bridge):
    job = bridge.enqueue('文' * 4200)
    await connected(bridge)
    await bridge.step()
    bridge.cancel(job['id'])
    assert bridge.job(job['id'])['state'] == 'CANCELLED'
    with pytest.raises(BridgeError):
        bridge.retry(job['id'])
    assert bridge.retry(job['id'], reviewed=True)['queued'] == 1
    current = bridge.job(job['id'])
    assert current['chunks'][0]['state'] == 'COMPLETED'
    assert current['chunks'][1]['state'] == 'QUEUED'
    assert bridge.audio_path(job['id'], 1).is_file()


@pytest.mark.asyncio
async def test_review_requires_explicit_confirmation_and_stays_paused(bridge):
    await connected(bridge)
    bridge.configure(paused=True, needs_review=True)
    with pytest.raises(BridgeError):
        await bridge.control('resume')
    with pytest.raises(BridgeError):
        await bridge.control('review')
    await bridge.control('review', reviewed=True)
    assert not bridge.settings()['needs_review']
    assert bridge.settings()['paused']
    await bridge.control('resume')
    assert not bridge.settings()['paused']


@pytest.mark.parametrize('payload', [
    {'audioBase64': base64.b64encode(b'<html>login</html>').decode(), 'mimeType': 'audio/mpeg'},
    {'audioBase64': '!!!!', 'mimeType': 'audio/mpeg'},
    {'audioBase64': wav_payload(), 'mimeType': 'text/html'},
    {'audioBase64': '', 'mimeType': 'audio/mpeg'},
])
def test_invalid_audio_does_not_create_success_file(bridge, payload):
    with pytest.raises(ValueError):
        bridge._save_audio('job', 1, payload)
    assert not (bridge.output / 'job' / '001.mp3').exists()


def test_audio_validation_limit_before_decode(bridge, monkeypatch):
    monkeypatch.setattr(module, 'MAX_AUDIO_BYTES', 8)
    with pytest.raises(ValueError, match='limit'):
        bridge._save_audio('job', 1, {'audioBase64': wav_payload(), 'mimeType': 'audio/wav'})


def test_audio_path_is_database_id_based(bridge):
    job = bridge.enqueue('Test')
    with pytest.raises(KeyError):
        bridge.audio_path(job['id'], '../../../etc/passwd')
    with pytest.raises(KeyError):
        bridge.audio_path('../../..', 1)


def test_websocket_requires_loopback_and_real_extension_origin():
    def socket(host, origin):
        return SimpleNamespace(client=SimpleNamespace(host=host), headers={'origin': origin})
    origin = 'chrome-extension://' + 'a' * 32
    assert api.trusted_websocket(socket('127.0.0.1', origin))
    assert api.trusted_websocket(socket('::1', origin))
    assert not api.trusted_websocket(socket('192.168.1.3', origin))
    assert not api.trusted_websocket(socket('127.0.0.1', 'https://elevenlabs.io'))
    assert not api.trusted_websocket(socket('127.0.0.1', ''))
    assert not api.trusted_websocket(socket('127.0.0.1', origin + '.evil'))


def test_api_preview_and_queue_preserve_text_and_validate_boundaries(bridge, monkeypatch):
    monkeypatch.setattr(api, 'bridge', bridge)
    app = FastAPI()
    app.include_router(api.router, prefix='/api')
    with TestClient(app) as client:
        preview = client.post('/api/elevenlabs/preview', json={'text': '日' * 5000})
        assert preview.status_code == 200 and preview.json()['total_chunks'] == 2
        job = client.post('/api/elevenlabs/jobs', json={'text': 'こんにちは。'}).json()
        assert job['model'] == 'Eleven v4'
        assert client.get('/api/elevenlabs/jobs/' + job['id']).json()['text'] == 'こんにちは。'
        assert client.post('/api/elevenlabs/jobs', json={'text': '   '}).status_code == 422
        assert client.post('/api/elevenlabs/jobs/' + job['id'] + '/retry', json={}).status_code == 409
        assert client.get('/api/elevenlabs/audio/' + job['id'] + '/1').status_code == 404


def test_restart_after_audio_commit_reconciles_job_and_requires_review(bridge):
    job = bridge.enqueue('Saved audio')
    with bridge.db() as connection:
        connection.execute("UPDATE eleven_jobs SET state='RUNNING' WHERE id=?", (job['id'],))
        connection.execute("UPDATE eleven_chunks SET state='COMPLETED',audio_file='001.wav' WHERE job_id=?", (job['id'],))
    restarted = ElevenLabsBridge(bridge.store, bridge.output)
    assert restarted.recover() == 1
    assert restarted.job(job['id'])['state'] == 'COMPLETED'
    assert restarted.job(job['id'])['chunks'][0]['audio_url']
    assert restarted.settings()['needs_review']


@pytest.mark.asyncio
@pytest.mark.parametrize('fresh_tab', [False, True])
async def test_later_chunks_pin_first_successful_voice(bridge, monkeypatch, fresh_tab):
    monkeypatch.setattr(bridge, '_merge_audio', lambda jid: None)
    bridge.enqueue('日' * 4200)
    peer = await connected(bridge, response={'ok': True, 'audioBase64': wav_payload(), 'mimeType': 'audio/wav', 'voice': 'Sakura'})
    if fresh_tab:
        await bridge.receive(peer, {'type': 'status', 'enabled': True, 'ready': True, 'tabId': None,
                                    'autoPrepareTab': True, 'busy': False, 'state': 'IDLE'})
    await bridge.step()
    await bridge.step()
    calls = [m for m in peer.sent if m['type'] == 'generate']
    assert calls[0]['expectedVoice'] is None
    assert calls[1]['expectedVoice'] == 'Sakura'


@pytest.mark.asyncio
async def test_shutdown_during_writer_waits_and_preserves_committed_audio(bridge, monkeypatch):
    import threading
    started, finish = threading.Event(), threading.Event()
    original = bridge._save_audio
    def writer(*args):
        started.set()
        assert finish.wait(2)
        return original(*args)
    monkeypatch.setattr(bridge, '_save_audio', writer)
    job = bridge.enqueue('Important audio')
    peer = await connected(bridge)
    task = asyncio.create_task(bridge.step())
    assert await asyncio.to_thread(started.wait, 2)
    task.cancel()
    await asyncio.sleep(0)
    assert not task.done()
    finish.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert bridge.job(job['id'])['chunks'][0]['state'] == 'COMPLETED'
    assert bridge.audio_path(job['id'], 1).exists()
    assert bridge.settings()['needs_review']
    assert not [m for m in peer.sent if m['type'] == 'commit' and m['ok']]


@pytest.mark.asyncio
@pytest.mark.parametrize('ready,tab_id', [(False, 7), (None, 7), (True, None), (True, True), (True, '7'), (True, -1)])
async def test_unbound_or_unready_extension_does_not_claim_queued_job(bridge, ready, tab_id):
    job = bridge.enqueue('Do not send until a tab is bound.')
    peer = await connected(bridge)
    await bridge.receive(peer, {'type': 'status', 'enabled': True, 'busy': False, 'state': 'IDLE',
                                'ready': ready, 'tabId': tab_id})
    assert await bridge.step() is False
    assert bridge.job(job['id'])['state'] == 'QUEUED'
    assert not peer.sent


@pytest.mark.asyncio
async def test_fresh_tab_worker_claims_without_bound_tab_and_has_preparation_budget(bridge, monkeypatch):
    job = bridge.enqueue('Fresh tab narration')
    peer = Peer(bridge)
    await bridge.connect(peer)
    await bridge.receive(peer, {'type': 'hello', 'enabled': True, 'ready': True, 'tabId': None,
                                'autoPrepareTab': True, 'busy': False, 'state': 'IDLE'})
    status = bridge.status()
    assert status['autoPrepareTab'] and status['ready'] and status['tabId'] is None
    calls = []
    original_request = bridge.request
    async def record_request(kind, *args, **kwargs):
        calls.append((kind, kwargs.get('timeout')))
        return await original_request(kind, *args, **kwargs)
    monkeypatch.setattr(bridge, 'request', record_request)
    assert await bridge.step()
    assert bridge.job(job['id'])['state'] == 'COMPLETED'
    assert calls == [('generate', 840), ('commit', 10)]
    assert peer.sent[0]['timeout'] == 600_000
    assert peer.sent[0]['text'] == job['text']


@pytest.mark.asyncio
@pytest.mark.parametrize('change', [
    {'enabled': False}, {'ready': False}, {'busy': True}, {'state': 'RUNNING'},
    {'state': 'NEEDS_REVIEW'}, {'state': 'AWAITING_SAVE'},
    {'autoPrepareTab': False}, {'autoPrepareTab': 'true'}, {'autoPrepareTab': 1},
])
async def test_fresh_tab_capability_does_not_bypass_dispatch_guards(bridge, change):
    job = bridge.enqueue('Do not start yet')
    peer = Peer(bridge)
    await bridge.connect(peer)
    await bridge.receive(peer, {'type': 'status', 'enabled': True, 'ready': True, 'tabId': None,
                                'autoPrepareTab': True, 'busy': False, 'state': 'IDLE', **change})
    assert await bridge.step() is False
    assert bridge.job(job['id'])['state'] == 'QUEUED'
    assert not peer.sent


@pytest.mark.asyncio
async def test_fresh_tab_capability_does_not_survive_reconnect_or_omitted_status(bridge):
    peer = Peer(bridge)
    await bridge.connect(peer)
    hello = {'type': 'status', 'enabled': True, 'ready': True, 'tabId': None,
             'autoPrepareTab': True, 'busy': False, 'state': 'IDLE'}
    await bridge.receive(peer, hello)
    assert bridge.status()['autoPrepareTab'] and bridge.status()['ready']
    await bridge.receive(peer, {key: value for key, value in hello.items() if key != 'autoPrepareTab'})
    assert not bridge.status()['autoPrepareTab'] and not bridge.status()['ready']
    await bridge.receive(peer, hello)
    await bridge.disconnect(peer)
    assert not bridge.status()['autoPrepareTab'] and not bridge.status()['ready']
    replacement = Peer(bridge)
    await bridge.connect(replacement)
    await bridge.receive(peer, hello)  # Stale connection must not restore capability.
    assert not bridge.status()['autoPrepareTab'] and not bridge.status()['ready']
    await bridge.receive(replacement, {key: value for key, value in hello.items() if key != 'autoPrepareTab'})
    bridge.enqueue('Legacy unbound worker')
    assert await bridge.step() is False
    assert not replacement.sent


def test_native_download_import_validates_audio_and_preserves_original(bridge, tmp_path, monkeypatch):
    token = '11111111-2222-4333-8444-555555555555'
    downloads = tmp_path / 'Downloads'
    source = downloads / 'flowkit-elevenlabs' / token / 'audio.mp3'
    source.parent.mkdir(parents=True)
    data = base64.b64decode(wav_payload())
    source.write_bytes(data)
    monkeypatch.setenv('ELEVENLABS_DOWNLOAD_DIR', str(downloads))
    result = {'nativeDownload': {'token': token, 'path': str(source)}}
    name = bridge._save_audio('native-test', 1, result)
    assert name == '001.wav'
    assert (bridge.output / 'native-test' / name).read_bytes() == data
    assert source.read_bytes() == data
    with pytest.raises(ValueError, match='location'):
        bridge._save_audio('native-test', 2, {'nativeDownload': {'token': token, 'path': str(tmp_path / 'elsewhere.mp3')}})
    source.write_text('<html>not audio</html>')
    with pytest.raises(ValueError, match='audio format'):
        bridge._save_audio('native-test', 2, result)


def test_native_download_rejects_path_escape_and_symlink(bridge, tmp_path, monkeypatch):
    monkeypatch.setenv('ELEVENLABS_DOWNLOAD_DIR', str(tmp_path))
    with pytest.raises(ValueError, match='identifier'):
        bridge._save_audio('native-test', 1, {'nativeDownload': {'token': '../secret', 'path': '/etc/passwd'}})
    token = '11111111-2222-4333-8444-555555555555'
    source = tmp_path / 'flowkit-elevenlabs' / token / 'audio.mp3'
    source.parent.mkdir(parents=True)
    target = tmp_path / 'private.wav'
    target.write_bytes(base64.b64decode(wav_payload()))
    source.symlink_to(target)
    with pytest.raises(ValueError, match='location'):
        bridge._save_audio('native-test', 1, {'nativeDownload': {'token': token, 'path': str(source)}})


def test_native_download_above_20_mib_is_streamed_without_size_limit(bridge, tmp_path, monkeypatch):
    import hashlib
    token = '11111111-2222-4333-8444-555555555555'
    root = tmp_path / 'Downloads'
    source = root / 'flowkit-elevenlabs' / token / 'audio.mp3'
    source.parent.mkdir(parents=True)
    with wave.open(str(source), 'wb') as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(48000)
        for _ in range(22):
            handle.writeframesraw(b'\0' * (1024 * 1024))
    monkeypatch.setenv('ELEVENLABS_DOWNLOAD_DIR', str(root))
    name = bridge._save_audio('large-native', 1, {'nativeDownload': {'token': token, 'path': str(source)}})
    target = bridge.output / 'large-native' / name
    assert target.stat().st_size == source.stat().st_size > 20 * 1024 * 1024
    with source.open('rb') as first, target.open('rb') as second:
        assert hashlib.file_digest(first, 'sha256').digest() == hashlib.file_digest(second, 'sha256').digest()


@pytest.mark.asyncio
async def test_unknown_generation_failure_still_requires_review(bridge):
    job = bridge.enqueue('May have used credits.')
    await connected(bridge, response={'ok': False, 'error': 'The connection closed.'})
    await bridge.step()
    assert bridge.job(job['id'])['state'] == 'NEEDS_REVIEW'
    assert bridge.job(job['id'])['retry_requires_review']
    assert bridge.settings()['needs_review']
    with pytest.raises(BridgeError):
        bridge.retry(job['id'], reviewed=True)


@pytest.mark.asyncio
async def test_review_lock_is_not_reported_as_processing_and_release_clears_stale_busy(bridge):
    peer = await connected(bridge)
    await bridge.receive(peer, {'type': 'status', 'enabled': True, 'ready': False, 'tabId': 7,
                                'busy': True, 'state': 'NEEDS_REVIEW'})
    status = bridge.status()
    assert status['blocked'] and status['reviewRequired']
    assert not status['busy'] and not status['processing']
    result = await bridge.control('review', reviewed=True)
    assert result['state'] == 'IDLE'
    assert not result['busy'] and not result['reviewRequired']
    assert result['settings']['paused']
    bridge.remote_busy = True
    await bridge.disconnect(peer)
    assert not bridge.status()['busy']


def test_cancel_pending_chunks_does_not_hide_uncertain_chunk(bridge):
    job = bridge.enqueue('文' * 4200)
    with bridge.db() as connection:
        connection.execute("UPDATE eleven_chunks SET state='NEEDS_REVIEW',error='Review this audio' WHERE job_id=? AND chunk_index=1", (job['id'],))
    bridge._finish_job(job['id'])
    assert bridge.cancel(job['id'])['cancelled'] == 1
    current = bridge.job(job['id'])
    assert current['state'] == 'NEEDS_REVIEW'
    assert current['chunks'][1]['state'] == 'CANCELLED'


@pytest.mark.asyncio
async def test_download_metadata_survives_import_failure_and_restart_for_no_generate_recovery(bridge, tmp_path, monkeypatch):
    token = '11111111-2222-4333-8444-555555555555'
    downloads = tmp_path / 'ChromeDownloads'
    source = downloads / 'flowkit-elevenlabs' / token / 'audio.mp3'
    source.parent.mkdir(parents=True)
    source.write_bytes(base64.b64decode(wav_payload()))
    monkeypatch.setenv('ELEVENLABS_DOWNLOAD_DIR', str(tmp_path / 'WrongDownloads'))
    job = bridge.enqueue('A downloaded chunk must not be generated twice.')
    peer = await connected(bridge, response={'ok': True, 'voice': 'Sakura', 'model': 'Eleven v4',
                                           'nativeDownload': {'token': token, 'path': str(source)}})
    await bridge.step()
    failed = bridge.job(job['id'])
    assert failed['state'] == 'NEEDS_REVIEW'
    assert failed['recoverable_downloads'] == 1
    assert failed['chunks'][0]['recoverable_download']
    assert failed['chunks'][0]['metadata']['nativeDownload']['path'] == str(source)
    assert bridge.jobs()[0]['recoverable_downloads'] == 1
    restarted = ElevenLabsBridge(bridge.store, bridge.output)
    restarted.recover()
    with pytest.raises(BridgeError, match='Release'):
        await restarted.recover_downloads(job['id'], reviewed=True)
    new_peer = await connected(restarted)
    await restarted.control('review', reviewed=True)
    monkeypatch.setenv('ELEVENLABS_DOWNLOAD_DIR', str(downloads))
    recovered = await restarted.recover_downloads(job['id'], reviewed=True)
    assert recovered['recovered'] == 1 and not recovered['errors']
    assert recovered['job']['state'] == 'COMPLETED'
    assert recovered['job']['error'] is None
    assert recovered['job']['recoverable_downloads'] == 0
    assert recovered['job']['merged_url']
    assert restarted.audio_path(job['id'], 1).read_bytes() == source.read_bytes()
    assert restarted.settings()['paused']
    assert not any(message['type'] == 'generate' for message in new_peer.sent)
    assert len([message for message in peer.sent if message['type'] == 'generate']) == 1


@pytest.mark.asyncio
async def test_recover_keeps_pause_and_metadata_when_file_is_still_unavailable(bridge):
    job = bridge.enqueue('Already generated audio')
    import json
    with bridge.db() as connection:
        connection.execute("UPDATE eleven_chunks SET state='NEEDS_REVIEW',metadata=? WHERE job_id=?",
                           (json.dumps({'nativeDownload': {'token': '11111111-2222-4333-8444-555555555555', 'path': '/not/the/download/folder'}}), job['id']))
    bridge._finish_job(job['id'])
    with pytest.raises(BridgeError):
        await bridge.recover_downloads(job['id'])
    result = await bridge.recover_downloads(job['id'], reviewed=True)
    assert result['recovered'] == 0
    assert result['errors'][0]['chunk_index'] == 1
    assert result['job']['recoverable_downloads'] == 1
    assert bridge.settings()['paused']


def test_single_chunk_joined_audio_does_not_require_ffmpeg(bridge, monkeypatch):
    job = bridge.enqueue('Single chunk')
    monkeypatch.setattr(module.shutil, 'which', lambda _: None)
    filename = bridge._save_audio(job['id'], 1, {'audioBase64': wav_payload(), 'mimeType': 'audio/wav'})
    with bridge.db() as connection:
        connection.execute("UPDATE eleven_chunks SET state='COMPLETED',audio_file=? WHERE job_id=?", (filename, job['id']))
    bridge._finish_job(job['id'])
    bridge._merge_audio(job['id'])
    assert bridge.job(job['id'])['merged_url']
    assert bridge.audio_path(job['id'], 'merged').read_bytes()


@pytest.mark.asyncio
async def test_no_submit_rejection_does_not_release_an_existing_remote_review_lock(bridge):
    job = bridge.enqueue('This request was not sent.')
    await connected(bridge, response={'ok': False, 'notSubmitted': True, 'state': 'NEEDS_REVIEW',
                                     'needsReview': True, 'error': 'Previous browser chunk needs review.'})
    await bridge.step()
    assert bridge.job(job['id'])['state'] == 'FAILED'
    assert bridge.settings()['needs_review'] and bridge.settings()['paused']
    with pytest.raises(BridgeError):
        bridge.retry(job['id'])


@pytest.mark.parametrize('length', [1198, 1199, 1200, 2398, 2399])
def test_custom_chunk_limit_is_strictly_under_1200(length):
    text = 'あ' * length
    chunks = split_text(text, maximum=1199)
    assert ''.join(chunk['text'] for chunk in chunks) == text
    assert all(0 < chunk['utf16_length'] < 1200 for chunk in chunks)
    assert len(chunks) == (length + 1198) // 1199


@pytest.mark.parametrize('limit', [100, 1200, 1500, 3000])
def test_api_custom_chunk_size_matches_preview_and_saved_job(bridge, monkeypatch, limit):
    monkeypatch.setattr(api, 'bridge', bridge)
    app = FastAPI()
    app.include_router(api.router, prefix='/api')
    with TestClient(app) as client:
        body = {'text': '日本語。😀' * 1100, 'max_chunk_characters': limit}
        preview = client.post('/api/elevenlabs/preview', json=body).json()
        job = client.post('/api/elevenlabs/jobs', json=body).json()
        assert [c['text'] for c in preview['chunks']] == [c['text'] for c in job['chunks']]
        assert ''.join(c['text'] for c in job['chunks']) == body['text']
        assert all(c['utf16_length'] <= limit for c in job['chunks'])
        for invalid in [99, 3001, 1500.5, True]:
            for route in ['preview', 'jobs']:
                assert client.post('/api/elevenlabs/' + route, json={**body, 'max_chunk_characters': invalid}).status_code == 422
