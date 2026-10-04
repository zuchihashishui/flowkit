import base64
import asyncio
import json
import httpx
import pytest
from agent.services.srt_service import SRTService, parse_srt, dispatch_status
from agent.services import chatgpt_gateway as g

SRT = '1\n00:00:00,000 --> 00:00:04,500\n日本語です。\n\n2\n00:00:05,000 --> 00:00:10,000\n次の文。\n'
READY = {'available': True, 'extensionConnected': True, 'enabled': True,
         'capabilities': ['json-attachment-v1','fresh-srt-tab-v1','dedicated-srt-v1'], 'availableSlots': 1, 'availableSrtSlots': 1,
         'settings': {'workers': 3, 'paused': False}, 'workers': [{'id': 'w1', 'state': 'IDLE'}]}


@pytest.mark.parametrize('overrides,code', [
    ({'available': False}, 'GATEWAY_UNAVAILABLE'),
    ({'extensionConnected': False}, 'EXTENSION_DISCONNECTED'),
    ({'capabilities': []}, 'EXTENSION_UPDATE_REQUIRED'),
    ({'capabilities': ['json-attachment-v1']}, 'EXTENSION_UPDATE_REQUIRED'),
    ({'enabled': False}, 'BRIDGE_OFF'),
    ({'settings': {'paused': True}}, 'QUEUE_PAUSED'),
    ({'needsReview': True}, 'ACCOUNT_REVIEW'),
    ({'inspecting': True}, 'INSPECTING'),
    ({'workers': [], 'availableSlots': 0, 'availableSrtSlots': 1}, 'READY'),
    ({'srtWorker': {'state': 'NEEDS_REVIEW'}, 'availableSlots': 0, 'availableSrtSlots': 0}, 'WORKER_REVIEW'),
    ({'srtWorker': {'state': 'AWAITING_SAVE'}, 'availableSlots': 0, 'availableSrtSlots': 0}, 'AWAITING_SAVE'),
    ({'srtWorker': {'state': 'RUNNING'}, 'availableSlots': 0, 'availableSrtSlots': 0}, 'WORKERS_BUSY'),
    ({'capabilities': ['json-attachment-v1','fresh-srt-tab-v1']}, 'EXTENSION_UPDATE_REQUIRED'),
    ({'workers': [{'state': 'RUNNING'}]*3, 'availableSlots': 0}, 'READY'),
    ({}, 'READY'),
])
def test_queue_readiness_explains_dispatch_conditions(overrides, code):
    status = dispatch_status({**READY, **overrides})
    assert status['code'] == code
    assert status['ready'] is (code == 'READY')
    assert status['message']


@pytest.mark.asyncio
async def test_waiting_for_attachment_support_then_dispatches_same_queued_job(tmp_path, monkeypatch):
    service = SRTService(tmp_path/'srt.db', tmp_path/'output')
    source = service.import_bytes(b'{"segments":[]}', 'transcript.json')
    jid = service.enqueue(source['id'], 'Private instructions', 'auto', 1800, method='legacy-srt')['id']
    state = {**READY, 'capabilities': [], 'workers': [], 'availableSlots': 0, 'availableSrtSlots': 1}
    calls = []
    async def status():
        return state
    async def complete(prompt, model, **kwargs):
        calls.append(kwargs)
        return kwargs['validate'](SRT)
    monkeypatch.setattr(g, 'status', status)
    monkeypatch.setattr(g, 'complete', complete)
    service.worker_running = True
    await service.step()
    waiting = service.status()
    assert calls == []
    assert waiting['jobs'][0]['id'] == jid
    assert waiting['jobs'][0]['wait_reason']['code'] == 'EXTENSION_UPDATE_REQUIRED'
    assert waiting['jobs'][0]['queue_position'] == 1
    assert 'prompt' not in waiting['jobs'][0]
    state['capabilities'] = ['json-attachment-v1','fresh-srt-tab-v1','dedicated-srt-v1']
    await service.step()
    assert service.jobs()[0]['state'] == 'COMPLETED'
    assert service.jobs()[0]['id'] == jid
    assert len(calls) == 1 and calls[0]['composer_mode'] == 'work'
    assert calls[0]['fresh_tab'] is True
    assert service.result_path(jid).read_text() == SRT
    await service.step()
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_cancelled_snapshot_is_not_submitted(tmp_path, monkeypatch):
    service = SRTService(tmp_path/'srt.db', tmp_path/'output')
    source = service.import_bytes(b'{"segments":[]}', 'transcript.json')
    jid = service.enqueue(source['id'], 'Make SRT', 'auto', 1800, method='legacy-srt')['id']
    snapshot = service.jobs()[0]
    service.cancel(jid)
    async def forbidden(*args, **kwargs):
        pytest.fail('Cancelled job was submitted')
    monkeypatch.setattr(g, 'complete', forbidden)
    await service.process(snapshot)
    assert service.jobs()[0]['state'] == 'CANCELLED'
    assert service.active_id is None


@pytest.mark.asyncio
async def test_queue_survives_a_transient_status_error(tmp_path, monkeypatch):
    service = SRTService(tmp_path/'srt.db', tmp_path/'output')
    source = service.import_bytes(b'{"segments":[]}', 'transcript.json')
    service.enqueue(source['id'], 'Make SRT', 'auto', 1800, method='legacy-srt')
    failed, completed = asyncio.Event(), asyncio.Event()
    checks = 0
    async def status():
        nonlocal checks
        checks += 1
        if checks == 1:
            failed.set()
            raise RuntimeError('Temporary database unavailable')
        return READY
    async def complete(prompt, model, **kwargs):
        result = kwargs['validate'](SRT)
        completed.set()
        return result
    monkeypatch.setattr(g, 'status', status)
    monkeypatch.setattr(g, 'complete', complete)
    task = asyncio.create_task(service.run())
    try:
        await asyncio.wait_for(failed.wait(), 1)
        assert not task.done()
        assert service.queue_status()['code'] == 'WORKER_ERROR'
        assert service.jobs()[0]['state'] == 'QUEUED'
        await asyncio.wait_for(completed.wait(), 5)
        assert service.jobs()[0]['state'] == 'COMPLETED'
        assert service.worker_error is None
        assert service.queue_status()['code'] == 'READY'
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert service.queue_status()['code'] == 'WORKER_STOPPED'

@pytest.mark.parametrize('answer', [SRT, 'Here is the result:\n```srt\n'+SRT+'```'])
def test_srt_preserves_timing_and_japanese(answer):
    text, count = parse_srt(answer)
    assert count == 2
    assert text == SRT

@pytest.mark.parametrize('answer', ['Download: https://example.com/a.srt', SRT.replace('00:00:05,000', '00:00:04,000'), SRT.replace('\n次の文。', ''), SRT.replace('\n\n2\n', '\n\n3\n'), '```srt\n'+SRT+'```\n```srt\n'+SRT+'```'])
def test_invalid_or_multiple_results_not_saved(answer):
    with pytest.raises(ValueError):
        parse_srt(answer)

@pytest.mark.asyncio
@pytest.mark.parametrize('valid', [True, False])
async def test_attachment_to_durable_srt_before_ack(tmp_path, monkeypatch, valid):
    service = SRTService(tmp_path/'srt.db', tmp_path/'output')
    monkeypatch.setattr(g, 'STORE', tmp_path/'gateway.db')
    monkeypatch.setattr(g, '_inflight', set())
    monkeypatch.setattr(g, '_srt_inflight', set())
    payload = json.dumps({'word_segments':[{'word':'日本語', 'start':0, 'end':4.5}]}, ensure_ascii=False).encode()
    source = service.import_bytes(payload, '日本語.json')
    jid = service.enqueue(source['id'], 'Custom instructions', 'GPT-6 Astra :: High', 1800, method='legacy-srt')['id']
    answer = '```srt\n' + SRT + '```\n\nFull audio duration is not supplied; the audio tail is unverified.' if valid else 'Only a download link'
    calls = []
    def handler(request):
        body = json.loads(request.content)
        calls.append((request.url.path, body))
        if request.url.path == '/commit':
            assert body['ok'] is valid
            assert (tmp_path/'output'/jid/'subtitles.srt').exists() is valid
            return httpx.Response(200, json={'ok':True})
        assert body['composerMode'] == 'work'
        assert body['temporary'] is False
        assert body['freshTab'] is True
        assert body['model'] == 'GPT-6 Astra :: High'
        assert body['timeout'] == 1800000
        assert base64.b64decode(body['attachment']['base64']) == payload
        assert body['messages'][0]['content'].startswith('Custom instructions')
        assert 'ONLY a WhisperX transcript JSON is attached, not audio' in body['messages'][0]['content']
        assert 'last aligned word\'s end is not' in body['messages'][0]['content']
        assert 'HH:MM:SS,mmm --> HH:MM:SS,mmm' in body['messages'][0]['content']
        return httpx.Response(200, json={'id':'remote', 'choices':[{'message':{'content':answer}}]})
    factory = httpx.AsyncClient
    monkeypatch.setattr(g.httpx, 'AsyncClient', lambda **kw: factory(transport=httpx.MockTransport(handler), **kw))
    await service.process(service.jobs()[0])
    assert service.jobs()[0]['state'] == ('COMPLETED' if valid else 'NEEDS_REVIEW')
    assert len(calls) == 2
    assert (tmp_path/'output'/jid/'response.txt').exists()
    assert (tmp_path/'output'/jid/'response.txt').read_text() == answer
    if valid:
        assert service.result_path(jid).read_text() == SRT
        reopened = SRTService(service.store, service.output)
        assert reopened.jobs()[0]['cues'] == 2
    else:
        with pytest.raises(ValueError):
            service.result_path(jid)

@pytest.mark.asyncio
async def test_import_api_and_queued_cancel(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from agent.api import srt
    service = SRTService(tmp_path/'srt.db', tmp_path/'output')
    monkeypatch.setattr(srt, 'service', service)
    app = FastAPI(); app.include_router(srt.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        for name, data in [('bad.json', b'not json'), ('bad.txt', b'{}'), ('empty.json', b'{}')]:
            assert (await client.post('/srt/import', files={'file':(name, data)})).status_code == 422
        source = (await client.post('/srt/import', files={'file':('../source.json', b'{"segments":[{"text":"Hello.","start":0,"end":4}],"duration":4}')})).json()
        assert source['title'] == 'source.json'
        response = await client.post('/srt/jobs', json={'source_id':source['id'], 'prompt':'Make SRT'})
        assert response.status_code == 200
        jid = response.json()['id']
        status = (await client.get('/srt/status')).json()
        assert status['queue']['diagnostics_version'] == 1
        assert status['jobs'][0]['wait_reason']['code'] == 'WORKER_STOPPED'
        assert 'prompt' not in status['jobs'][0]
        assert (await client.get('/srt/jobs/'+jid+'/result')).status_code == 404
        assert (await client.post('/srt/jobs/'+jid+'/cancel')).json()['cancelled'] == 1
        assert service.jobs()[0]['state'] == 'CANCELLED'
