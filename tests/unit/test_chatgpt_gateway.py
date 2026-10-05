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
    monkeypatch.setattr(g,'_srt_inflight',set())
    monkeypatch.setattr(g,'_cleanup_pending',False)

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
    sent = json.loads(calls[0].content)
    assert sent['composerMode'] == 'chat' and sent['temporary'] is True

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
async def test_200_jobs_max_three_text_requests_while_one_srt_runs_and_save_before_ack(monkeypatch):
    peak=0
    active=set()
    acks=[]
    srt_started, release_srt = asyncio.Event(), asyncio.Event()
    srt_calls = []
    async def handler(request):
        nonlocal peak
        body=json.loads(request.content)
        if body.get('freshTab'):
            srt_calls.append(body)
            assert body['composerMode']=='work' and body['temporary'] is False
            srt_started.set()
            await release_srt.wait()
            return httpx.Response(200,json={'id':'srt','choices':[{'message':{'content':'SRT result'}}]})
        if request.url.path=='/commit':
            rid=body['request_id']
            if rid=='srt':
                assert any(r['prompt']=='SRT' and r['state']=='COMPLETED' for r in g.audit_rows())
                return httpx.Response(200,json={'ok':True})
            with g.db() as c:
                row=c.execute('SELECT * FROM chat_queue WHERE prompt=?',(rid,)).fetchone()
                assert row['state']=='COMPLETED'
                assert row['answer']=='answer:'+rid
            active.remove(rid)
            acks.append(rid)
            return httpx.Response(200,json={'ok':True})
        rid=body['messages'][0]['content']
        assert body['composerMode']=='chat' and body['temporary'] is True
        assert 'attachment' not in body
        active.add(rid);peak=max(peak,len(active))
        await asyncio.sleep(0.001)
        return httpx.Response(200,json={'id':rid,'choices':[{'message':{'content':'answer:'+rid}}]})
    factory=httpx.AsyncClient
    monkeypatch.setattr(g.httpx,'AsyncClient',lambda **kw:factory(transport=httpx.MockTransport(handler),**kw))
    g.update_settings({'temporary':False})  # Legacy saved setting cannot change text jobs.
    g.enqueue([str(i) for i in range(200)])
    jobs=g.queue_rows()
    srt=asyncio.create_task(g.complete('SRT',attachment={'name':'transcript.json','base64':'e30='},fresh_tab=True))
    try:
        await asyncio.wait_for(srt_started.wait(), 2)
        with pytest.raises(g.GatewayBusy):
            await g.complete('Duplicate SRT',attachment={},fresh_tab=True)
        with pytest.raises(g.GatewayReviewRequired):
            await g.reset()
        for i in range(0,200,3):
            await asyncio.gather(*(g.process_job(job) for job in jobs[i:i+3]))
        assert not srt.done()
        assert peak==3 and len(acks)==200 and len(srt_calls)==1
    finally:
        release_srt.set()
        assert await asyncio.wait_for(srt, 2)=='SRT result'
    assert all(j['state']=='COMPLETED' and j['answer']=='answer:'+j['prompt'] for j in g.queue_rows())
    assert not g._inflight
    assert not g._srt_inflight

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
        assert json.loads(request.content)=={'kind':'preflight','model':'GPT-6 Astra :: high','workers':2,'composerMode':'chat','temporary':True}
        return httpx.Response(200,json={'passed':True})
    factory=httpx.AsyncClient
    monkeypatch.setattr(g.httpx,'AsyncClient',lambda **kw:factory(transport=httpx.MockTransport(handler),**kw))
    g.update_settings({'workers':2,'temporary':False})
    assert (await g.inspect_tabs('preflight','GPT-6 Astra :: high'))['passed']
    assert (await g.status())['availableSlots']==0
    g._inflight.add('busy')
    with pytest.raises(g.GatewayBusy):await g.inspect_tabs('discoverModels')
    assert len(seen)==2

@pytest.mark.asyncio
async def test_text_and_json_workflows_keep_request_options_isolated(monkeypatch):
    seen={}
    ready=asyncio.Event()
    g.update_settings({'temporary':False, 'workers':3})
    original=g.settings()
    async def handler(request):
        body=json.loads(request.content)
        if request.url.path=='/commit':
            assert body['ok'] is True
            assert any(r['state']=='COMPLETED' for r in g.audit_rows())
            return httpx.Response(200,json={'ok':True})
        prompt=body['messages'][0]['content']
        seen[prompt]=body
        if len(seen)==3: ready.set()
        await ready.wait()
        return httpx.Response(200,json={'id':prompt,'choices':[{'message':{'content':'answer:'+prompt}}]})
    factory=httpx.AsyncClient
    monkeypatch.setattr(g.httpx,'AsyncClient',lambda **kw:factory(transport=httpx.MockTransport(handler),**kw))
    attachment={'name':'transcript.json','base64':'e30='}
    await asyncio.wait_for(asyncio.gather(
        g.complete('text'),
        g.complete('srt','GPT-6 Astra',attachment=attachment,composer_mode='work',temporary=False,timeout_seconds=1800),
        g.complete('text-custom','Selected chat model'),
    ),timeout=5)
    for prompt in ['text','text-custom']:
        assert seen[prompt]['composerMode']=='chat' and seen[prompt]['temporary'] is True
        assert 'attachment' not in seen[prompt]
    assert seen['text']['model']=='auto'
    assert seen['text-custom']['model']=='Selected chat model'
    assert seen['srt']['composerMode']=='work' and seen['srt']['temporary'] is False
    assert seen['srt']['attachment']==attachment and seen['srt']['model']=='GPT-6 Astra'
    assert seen['srt']['timeout']==1800000
    await g.complete('text-after-work')
    assert seen['text-after-work']['composerMode']=='chat' and seen['text-after-work']['temporary'] is True
    assert 'attachment' not in seen['text-after-work']
    assert g.settings()==original

@pytest.mark.asyncio
@pytest.mark.parametrize('workers,limit,inflight,changes,expected_text,expected_srt', [
    ([],3,0,{},0,1),
    ([],1,0,{},0,1),
    (['RUNNING','IDLE'],3,1,{},1,1),
    (['RUNNING','IDLE'],1,0,{},0,1),
    (['RUNNING','AWAITING_SAVE','NEEDS_REVIEW'],3,0,{},0,1),
    (['NEEDS_REVIEW'],3,0,{},0,1),
    ([],3,3,{},0,1),
    (['IDLE']*3,3,0,{'srtWorker':{'state':'RUNNING'}},3,0),
    (['IDLE']*3,3,0,{'srtWorker':{'state':'AWAITING_SAVE'}},3,0),
    (['IDLE']*3,3,0,{'srtWorker':{'state':'NEEDS_REVIEW'}},3,0),
    (['RUNNING']*3,3,3,{'srtWorker':{'state':'IDLE'}},0,1),
    ([],3,0,{'capabilities':['json-attachment-v1']},0,0),
    ([],3,0,{'enabled':False},0,0),
    ([],3,0,{'extensionConnected':False},0,0),
    ([],3,0,{'inspecting':True},0,0),
    ([],3,0,{'needsReview':True},0,0),
])
async def test_single_srt_capacity_is_independent_of_three_text_workers(monkeypatch,workers,limit,inflight,changes,expected_text,expected_srt):
    info={'service':'flowkit-chatgpt-gateway','protocol':2,'enabled':True,'extensionConnected':True,
          'capabilities':['json-attachment-v1','fresh-srt-tab-v1','dedicated-srt-v1'],
          'workers':[{'id':str(i),'tabId':None if state=='RUNNING' else i,'state':state} for i,state in enumerate(workers)],**changes}
    factory=httpx.AsyncClient
    monkeypatch.setattr(g.httpx,'AsyncClient',lambda **kw:factory(transport=httpx.MockTransport(lambda _:httpx.Response(200,json=info)),**kw))
    g.update_settings({'workers':limit})
    g._inflight.update(str(i) for i in range(inflight))
    status=await g.status()
    assert status['availableSlots']==expected_text
    assert status['availableSrtSlots']==expected_srt
    g._srt_inflight.add('reserved')
    assert (await g.status())['availableSrtSlots']==0
    g._srt_inflight.clear()
    g.update_settings({'paused':True})
    assert (await g.status())['availableSrtSlots']==0


@pytest.mark.asyncio
@pytest.mark.parametrize('kind',['image','video'])
async def test_project_gpt_sends_exact_scene_text_and_saves_only_target_prompt(monkeypatch,kind):
    calls=transport(monkeypatch,{'choices':[{'message':{'content':'A new visual prompt'}}]})
    text='日本語の段落。\nSecond line — exactly as saved.'
    url='https://chatgpt.com/g/g-channel-'+kind
    payload={'provider':'chatgpt-web','prompt_kind':kind,'text':text,'retained_prompt':'Keep other prompt','project_settings':{kind+'_prompt_url':url}}
    result=await write_concept(payload)
    sent=json.loads(calls[0].content)
    assert sent['messages']==[{'role':'user','content':text}]
    assert sent['pageUrl']==url and sent['temporary'] is False and sent['model']=='auto'
    assert 'attachment' not in sent
    assert getattr(result,kind+'_prompt')=='A new visual prompt'
    assert getattr(result,('video' if kind=='image' else 'image')+'_prompt')=='Keep other prompt'
    assert g.audit_rows()[0]['state']=='COMPLETED'


@pytest.mark.asyncio
async def test_rejected_project_url_is_not_an_uncertain_browser_submission(monkeypatch):
    transport(monkeypatch,{'not_submitted':True,'error':'Reload ChatGPT Bridge for project URLs.'},400)
    with pytest.raises(g.GatewayNotSubmitted):
        await g.complete('Scene',page_url='https://chatgpt.com/g/g-test',temporary=False)
    assert g.audit_rows()[0]['state']=='NOT_SUBMITTED'
    assert not g.blocked()


@pytest.mark.asyncio
async def test_txt_instructions_are_session_metadata_and_scene_is_the_only_message(monkeypatch):
    calls=transport(monkeypatch,{'choices':[{'message':{'content':'Generated image prompt'}}]})
    payload={'provider':'chatgpt-web','prompt_kind':'image','text':'日本語のSRT行。','retained_prompt':'','project_settings':{'image_prompt_url':'https://chatgpt.com/g/g-old-image','chatgpt_url':'https://chatgpt.com/'},'text_session_id':'11111111-1111-1111-1111-111111111111','prompt_template':'Create a visual prompt.\nKeep the same style.'}
    result=await write_concept(payload)
    request=json.loads(calls[0].content)
    assert request['messages']==[{'role':'user','content':payload['text']}]
    assert request['textSessionId']==payload['text_session_id']
    assert request['promptTemplate']==payload['prompt_template']
    assert request['pageUrl']=='https://chatgpt.com/'
    assert request['temporary'] is True and request['composerMode']=='chat'
    assert result.image_prompt=='Generated image prompt'

@pytest.mark.asyncio
async def test_worker_502_preserves_actionable_error_phase_and_partial_response(monkeypatch):
    transport(monkeypatch,{'error':'TXT upload failed in the composer','phase':'ATTACHING_FILE','submitted':False,'partialResponse':'Retained diagnostic text'},502)
    with pytest.raises(g.GatewayReviewRequired,match=r'ATTACHING_FILE \(before Send\): TXT upload failed'):
        await g.complete('prompt')
    row=g.audit_rows()[0]
    assert '502 Bad Gateway' not in row['error']
    assert 'Retained diagnostic text' in row['response']
    assert row['state']=='NEEDS_REVIEW'
