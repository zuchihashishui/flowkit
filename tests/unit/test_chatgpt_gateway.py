import asyncio
import json
import httpx
import pytest
from agent.services import chatgpt_gateway as g
from agent.services.concept_writer import parse_concept, write_concept

@pytest.fixture(autouse=True)
def store(tmp_path,monkeypatch):
    monkeypatch.setattr(g,'STORE',tmp_path/'chatgpt.db')
    monkeypatch.setattr(g,'_inflight',set())

def transport(monkeypatch, result, status=200):
    calls=[]
    def handler(request):
        calls.append(request)
        if request.url.path=='/health':
            return httpx.Response(200,json={'service':'flowkit-chatgpt-gateway','protocol':2,'enabled':True,'extensionConnected':True,'workers':[{'id':'w1','state':'IDLE'}]})
        if request.url.path in ('/commit','/review/reset'):
            if request.url.path=='/commit' and json.loads(request.content)['ok']:
                assert g.audit_rows()[0]['state']=='COMPLETED'  # ACK only after DB commit
            return httpx.Response(200,json={'ok':True})
        return httpx.Response(status,json={'id':'remote-id',**result})
    factory=httpx.AsyncClient
    monkeypatch.setattr(g.httpx,'AsyncClient',lambda **kw:factory(transport=httpx.MockTransport(handler),**kw))
    return calls

@pytest.mark.asyncio
async def test_concept_provider_audits_then_acknowledges(monkeypatch):
    concept=dict(title='River',description='A river',image_prompt='A river at dawn',video_prompt='Water flows')
    calls=transport(monkeypatch,{'choices':[{'message':{'content':json.dumps(concept)}}],'conversation_url':'https://chatgpt.com/c/test'})
    payload=dict(provider='chatgpt-web',text='River',start_ms=0,end_ms=3000,visual_style='realistic',script_context='',previous_text='',next_text='')
    result=await write_concept(payload)
    assert result.title=='River'
    assert g.audit_rows()[0]['state']=='COMPLETED'
    assert 'conversation_url' in g.audit_rows()[0]['response']
    assert [r.url.path for r in calls]==['/v1/chat/completions','/commit']

@pytest.mark.asyncio
async def test_invalid_json_quarantines_worker_without_retry(monkeypatch):
    calls=transport(monkeypatch,{'choices':[{'message':{'content':'unfinished response'}}]})
    with pytest.raises(g.GatewayReviewRequired):
        await g.complete('prompt',validate=parse_concept)
    assert g.blocked()
    assert len([r for r in calls if r.url.path=='/v1/chat/completions'])==1
    assert json.loads(calls[-1].content)['ok'] is False
    assert 'unfinished response' in g.audit_rows()[0]['response']
    await g.reset()
    assert not g.blocked()

@pytest.mark.asyncio
async def test_gateway_failure_remains_review_required(monkeypatch):
    transport(monkeypatch,{'error':'Extension disconnected'},502)
    with pytest.raises(g.GatewayReviewRequired):
        await g.complete('prompt')
    assert (await g.status())['hasReviewJobs']
    assert g.audit_rows()[0]['state']=='NEEDS_REVIEW'

@pytest.mark.asyncio
async def test_known_not_submitted_goes_back_to_queue(monkeypatch):
    transport(monkeypatch,{'not_submitted':True,'error':'Busy'},409)
    g.enqueue(['hello'])
    await g.process_job(g.queue_rows()[0])
    assert g.queue_rows()[0]['state']=='QUEUED'
    assert g.audit_rows()[0]['state']=='NOT_SUBMITTED'

@pytest.mark.asyncio
async def test_150_jobs_max_three_requests_and_saved_answers_before_ack(monkeypatch):
    peak=0
    active=set()
    acks=[]
    async def handler(request):
        nonlocal peak
        body=json.loads(request.content)
        if request.url.path=='/commit':
            rid=body['request_id']
            with g.db() as c:
                row=c.execute('SELECT * FROM chat_queue WHERE prompt=?',(rid,)).fetchone()
                assert row['state']=='COMPLETED'
                assert row['answer']=='answer:'+rid
            active.remove(rid)
            acks.append(rid)
            return httpx.Response(200,json={'ok':True})
        rid=body['messages'][0]['content']
        active.add(rid);peak=max(peak,len(active))
        await asyncio.sleep(0.001)
        return httpx.Response(200,json={'id':rid,'choices':[{'message':{'content':'answer:'+rid}}]})
    factory=httpx.AsyncClient
    monkeypatch.setattr(g.httpx,'AsyncClient',lambda **kw:factory(transport=httpx.MockTransport(handler),**kw))
    g.enqueue([str(i) for i in range(150)])
    jobs=g.queue_rows()
    for i in range(0,150,3):
        await asyncio.gather(*(g.process_job(job) for job in jobs[i:i+3]))
    assert peak==3 and len(acks)==150
    assert all(j['state']=='COMPLETED' and j['answer']=='answer:'+j['prompt'] for j in g.queue_rows())
    assert not g._inflight

def test_restart_preserves_queue_and_pauses_uncertain_jobs():
    g.enqueue(['queued','interrupted'])
    with g.db() as c:
        c.execute("UPDATE chat_queue SET state='RUNNING' WHERE prompt='interrupted'")
    g.recover()
    assert {r['prompt']:r['state'] for r in g.queue_rows()}=={'queued':'QUEUED','interrupted':'NEEDS_REVIEW'}
    assert g.settings()['paused'] is True

@pytest.mark.asyncio
async def test_saved_result_survives_failed_release_ack(monkeypatch):
    transport(monkeypatch,{'choices':[{'message':{'content':'saved answer'}}]})
    async def broken(*args):
        raise RuntimeError('ack lost')
    monkeypatch.setattr(g,'commit',broken)
    g.enqueue(['hello'])
    await g.process_job(g.queue_rows()[0])
    assert g.queue_rows()[0]['state']=='COMPLETED'
    assert g.audit_rows()[0]['state']=='COMPLETED'
    assert 'release unconfirmed' in g.audit_rows()[0]['error']

@pytest.mark.asyncio
async def test_inspection_uses_saved_settings_and_blocks_scheduler(monkeypatch):
    seen=[]
    def handler(request):
        seen.append(request)
        if request.url.path=='/health':
            return httpx.Response(200,json={'service':'flowkit-chatgpt-gateway','protocol':2,'enabled':True,'inspecting':True,'workers':[{'id':'w1','state':'IDLE'}]})
        assert request.url.path=='/inspect'
        assert json.loads(request.content)=={'kind':'preflight','model':'GPT-6 Astra :: high','workers':2,'temporary':False}
        return httpx.Response(200,json={'passed':True})
    factory=httpx.AsyncClient
    monkeypatch.setattr(g.httpx,'AsyncClient',lambda **kw:factory(transport=httpx.MockTransport(handler),**kw))
    g.update_settings({'workers':2,'temporary':False})
    assert (await g.inspect_tabs('preflight','GPT-6 Astra :: high'))['passed']
    assert (await g.status())['availableSlots']==0
    g._inflight.add('busy')
    with pytest.raises(g.GatewayBusy):await g.inspect_tabs('discoverModels')
    assert len(seen)==2
