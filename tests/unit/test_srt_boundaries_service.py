import base64
import json
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest

from agent.services import chatgpt_gateway as gateway
from agent.services import srt_service as module
from agent.services.srt_service import SRTService


def transcript(duration=10):
    return json.dumps({'language':'ja', 'metadata':{'audio_duration_seconds':duration},
        'segments':[{'text':'日本語です。次の文。', 'words':[
            {'word':'日本語です。','start':.2,'end':4.2},
            {'word':'次の文。','start':5,'end':9.7}]}]}, ensure_ascii=False).encode()


@pytest.mark.asyncio
@pytest.mark.parametrize('case', ['passed', 'exception', 'invalid'])
async def test_source_boundaries_save_before_ack_and_quality_gates_next_stage(tmp_path, monkeypatch, case):
    service=SRTService(tmp_path/'srt.db', tmp_path/'output')
    monkeypatch.setattr(gateway, 'STORE', tmp_path/'gateway.db')
    monkeypatch.setattr(gateway, '_inflight', set())
    monkeypatch.setattr(gateway, '_srt_inflight', set())
    source=service.import_bytes(transcript(40 if case=='exception' else 10), 'source.json')
    jid=service.enqueue(source['id'], 'Group scenes naturally', 'GPT-6 Astra', 1800)['id']
    original_plan=(service.output/jid/'source-plan.json').read_bytes()
    # Queued jobs use their immutable snapshot even if the imported file changes.
    (service.output/(source['id']+'.json')).write_bytes(b'{"segments":[]}')
    calls=[]
    def handler(request):
        body=json.loads(request.content);calls.append(request.url.path)
        if request.url.path=='/commit':
            valid=case!='invalid'
            assert body['ok'] is valid
            assert (service.output/jid/'subtitles.srt').exists() is valid
            assert service.jobs()[0]['state']==('COMPLETED' if valid else 'RUNNING')
            assert service.quality(jid)['status']==('PASSED' if case=='passed' else 'REVIEW' if valid else 'BLOCKED')
            if valid:
                assert (service.output/jid/'quality.json').exists()
            return httpx.Response(200, json={'ok':True})
        assert body['composerMode']=='work' and not body['temporary'] and body['freshTab']
        assert body['messages'][0]['content'].startswith('Group scenes naturally')
        attached=json.loads(base64.b64decode(body['attachment']['base64']))
        assert len(attached['units'])==2
        assert 'segments' not in attached and 'original_text' not in attached
        assert attached['units'][0]['text']=='日本語です。'
        reply={'schema_version':1, 'source_sha256':attached['source_sha256'],
               'scene_end_unit_ids':[1] if case=='invalid' else [1,2]}
        # Existing extension wraps attachment-result code as srt, even for JSON.
        return httpx.Response(200,json={'id':'remote', 'choices':[{'message':{'content':'```srt\n'+json.dumps(reply)+'\n```\n\nSelected scene boundaries.'}}]})
    factory=httpx.AsyncClient
    monkeypatch.setattr(gateway.httpx,'AsyncClient',lambda **kw:factory(transport=httpx.MockTransport(handler),**kw))
    await service.process(service.jobs()[0])
    assert len(calls)==2 and calls[-1]=='/commit'
    assert (service.output/jid/'source-plan.json').read_bytes()==original_plan
    reopened=SRTService(service.store,service.output)
    assert reopened.jobs()[0]['method']=='source-boundaries-v1'
    assert 'scenes' not in reopened.jobs()[0]['quality']
    if case=='invalid':
        assert reopened.jobs()[0]['state']=='NEEDS_REVIEW'
        assert any(i['code']=='INVALID_BOUNDARY_RESPONSE' for i in reopened.quality(jid)['issues'])
        assert (service.output/jid/'response.txt').exists()
        with pytest.raises(ValueError):reopened.result_path(jid)
    else:
        text=reopened.result_path(jid).read_text()
        assert '00:00:00,000 --> 00:00:05,000' in text
        assert '日本語です。' in text and '次の文。' in text
        if case=='exception':
            with pytest.raises(ValueError,match='quality report'):reopened.result_path(jid,require_approved=True)
            accepted=reopened.approve_quality(jid)
            assert accepted['approved'] and accepted['duration_exception_count']==1
        assert reopened.result_path(jid,require_approved=True).exists()


@pytest.mark.asyncio
async def test_optional_analysis_reports_source_issues_but_file_download_job_can_queue(tmp_path,monkeypatch):
    from fastapi import FastAPI
    from agent.api import srt
    service=SRTService(tmp_path/'srt.db',tmp_path/'output');monkeypatch.setattr(srt,'service',service)
    app=FastAPI();app.include_router(srt.router)
    source=service.import_bytes(b'{"segments":[]}', 'empty.json')
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        response=await client.post('/srt/analyze',json={'source_id':source['id']})
        assert response.status_code==200 and response.json()['status']=='BLOCKED'
        response=await client.post('/srt/jobs',json={'source_id':source['id'],'prompt':'Make scenes'})
        assert response.status_code==200 and len(service.jobs())==1
        assert not (service.output/response.json()['id']/'source-plan.json').exists()
        assert (await client.get(f'/srt/jobs/{uuid4()}/quality')).status_code==404
        valid=service.import_bytes(transcript(),'valid.json')
        response=await client.post('/srt/analyze',json={'source_id':valid['id'],'duration_seconds':2})
        assert response.json()['status']=='BLOCKED'
        assert (await client.post('/srt/analyze',json={'source_id':valid['id'],'duration_seconds':-1})).status_code==422
        jid=service.enqueue(valid['id'],'Make scenes','auto',1800)['id']
        assert (await client.post(f'/srt/jobs/{jid}/approve',json={'reviewed':False})).status_code==422
        assert (await client.post(f'/srt/jobs/{jid}/approve',json={'reviewed':True})).status_code==409


def test_old_whisperx_duration_is_recovered_without_modifying_its_json(tmp_path,monkeypatch):
    source=tmp_path/'old.json'
    source.write_text('{"segments":[{"text":"Speech","start":0,"end":4}]}')
    before=source.read_bytes()
    monkeypatch.setattr(module,'whisperx',SimpleNamespace(result_path=lambda _:source,
        job=lambda _:{'progress':{'audio_seconds':6.25}}))
    service=SRTService(tmp_path/'srt.db',tmp_path/'output')
    plan=service.analyze(str(uuid4()))
    assert plan['duration_ms']==6250 and plan['report']['full_audio_duration_known']
    assert source.read_bytes()==before


@pytest.mark.asyncio
async def test_preexisting_queued_job_keeps_legacy_transport(tmp_path,monkeypatch):
    service=SRTService(tmp_path/'srt.db',tmp_path/'output')
    source=service.import_bytes(transcript(),'old.json');jid=str(uuid4())
    with service.db() as db:
        db.execute('INSERT INTO srt_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?)',
            (jid,source['id'],'Old job','Old instructions','auto',1800,'QUEUED',None,None,1,1))
    old_srt='1\n00:00:00,000 --> 00:00:10,000\n日本語です。次の文。\n'
    async def complete(prompt,model,**kwargs):
        assert 'COMPLETE final SRT' in prompt
        assert base64.b64decode(kwargs['attachment']['base64'])==transcript()
        return kwargs['validate'](old_srt)
    monkeypatch.setattr(gateway,'complete',complete)
    await service.process(service.jobs()[0])
    assert service.quality(jid)['status']=='LEGACY'
    assert service.result_path(jid,require_approved=True).read_text()==old_srt
