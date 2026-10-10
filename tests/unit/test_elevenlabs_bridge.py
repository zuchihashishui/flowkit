from unittest.mock import AsyncMock
import pytest
from agent.services.elevenlabs_bridge import BridgeError, split_text, utf16_length


@pytest.mark.parametrize('text', ['日本語。\n' * 50, 'Hello world! ' * 40, '🙂日本' * 100, 'x' * 400])
def test_lossless_chunks_offsets_and_utf16_limit(text):
    chunks = split_text(text, maximum=100)
    assert ''.join(c['text'] for c in chunks) == text
    assert chunks[0]['start'] == 0 and chunks[-1]['end'] == len(text)
    for i, c in enumerate(chunks):
        assert c['text'] == text[c['start']:c['end']]
        assert 0 < c['utf16_length'] == utf16_length(c['text']) <= 100
        if i:
            assert chunks[i-1]['end'] == c['start']


@pytest.mark.parametrize('text', ['', '   ', '\ud800'])
def test_invalid_text(text):
    with pytest.raises(ValueError):
        split_text(text)


def test_cancel_retry_keeps_completed_chunks(eleven):
    job = eleven.enqueue('x' * 250, max_chunk_characters=100)
    with eleven.db() as db:
        db.execute("UPDATE eleven_chunks SET state='COMPLETED',audio_file='001.mp3' WHERE job_id=? AND chunk_index=1", (job['id'],))
    assert eleven.cancel(job['id'])['cancelled'] == 2
    with pytest.raises(BridgeError, match='reviewed'):
        eleven.retry(job['id'])
    eleven.retry(job['id'], reviewed=True)
    assert [c['state'] for c in eleven.job(job['id'])['chunks']] == ['COMPLETED', 'QUEUED', 'QUEUED']


def test_restart_quarantines_running_audio(eleven):
    job = eleven.enqueue('hello')
    with eleven.db() as db:
        db.execute("UPDATE eleven_jobs SET state='RUNNING' WHERE id=?", (job['id'],))
        db.execute("UPDATE eleven_chunks SET state='RUNNING' WHERE job_id=?", (job['id'],))
    assert eleven.recover() == 1
    assert eleven.job(job['id'])['state'] == 'NEEDS_REVIEW'
    assert eleven.settings()['paused'] and eleven.settings()['needs_review']


@pytest.mark.parametrize('result,state,review', [
    ({'ok': False, 'notSubmitted': True, 'error': 'not ready'}, 'FAILED', False),
    ({'ok': False, 'error': 'response lost'}, 'NEEDS_REVIEW', True),
    ({'ok': False, 'notSubmitted': True, 'needsReview': True}, 'FAILED', True),
])
async def test_failed_generation_not_automatically_repeated(eleven, monkeypatch, result, state, review):
    job = eleven.enqueue('hello')
    eleven.peer = AsyncMock()
    eleven.enabled = eleven.ready = True
    eleven.remote_state = 'IDLE'
    request = AsyncMock(return_value=result)
    monkeypatch.setattr(eleven, 'request', request)
    assert await eleven.step() is True
    assert eleven.job(job['id'])['state'] == state
    assert eleven.settings()['needs_review'] is review
    assert eleven.active is None
    assert await eleven.step() is False
    request.assert_awaited_once()


async def test_saved_audio_survives_missing_ack(eleven, monkeypatch):
    job = eleven.enqueue('hello')
    eleven.peer = AsyncMock()
    eleven.enabled = eleven.ready = True
    eleven.remote_state = 'IDLE'
    async def request(kind, *args, **kwargs):
        if kind == 'generate':
            return {'ok': True, 'voice': 'test'}
        assert kind == 'commit'
        chunk = eleven.job(job['id'])['chunks'][0]
        assert chunk['state'] == 'COMPLETED' and chunk['audio_url'].endswith('/1')
        raise TimeoutError('ACK lost')
    monkeypatch.setattr(eleven, 'request', request)
    monkeypatch.setattr(eleven, '_save_audio', lambda *args: '001.mp3')
    assert await eleven.step() is True
    assert eleven.job(job['id'])['state'] == 'COMPLETED'
    assert eleven.settings()['needs_review'] is True
    assert await eleven.step() is False


async def test_disconnected_and_paused_queue_no_generation(eleven, monkeypatch):
    eleven.enqueue('hello')
    request = AsyncMock()
    monkeypatch.setattr(eleven, 'request', request)
    assert await eleven.step() is False
    eleven.peer = AsyncMock()
    eleven.enabled = eleven.ready = True
    eleven.remote_state = 'IDLE'
    eleven.configure(paused=True)
    assert await eleven.step() is False
    request.assert_not_awaited()


@pytest.mark.parametrize('payload', [{'audioBase64': '@@', 'mimeType': 'audio/mpeg'}, {'audioBase64': 'aGVsbG8=', 'mimeType': 'audio/mpeg'}, {'nativeDownload': {'token': '../../bad', 'path': '/tmp/audio.mp3'}}])
def test_invalid_audio_not_saved(eleven, payload):
    job = eleven.enqueue('hello')
    with pytest.raises(ValueError):
        eleven._save_audio(job['id'], 1, payload)
    assert not eleven.output.exists()
