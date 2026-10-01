import json
import httpx
import pytest
from agent.services import chatgpt_gateway as g
from agent.services.concept_writer import parse_concept, write_concept

@pytest.fixture(autouse=True)
def store(tmp_path,monkeypatch):
    monkeypatch.setattr(g,'STORE',tmp_path/'chatgpt.db')

def transport(monkeypatch, result, status=200):
    calls=[]
    def handler(request):
        calls.append(request)
        if request.url.path=='/health':
            return httpx.Response(200,json={'service':'flowkit-chatgpt-gateway','protocol':1,'extensionConnected':True})
        return httpx.Response(status,json=result)
    factory=httpx.AsyncClient
    monkeypatch.setattr(g.httpx,'AsyncClient',lambda **kw:factory(transport=httpx.MockTransport(handler),**kw))
    return calls

@pytest.mark.asyncio
async def test_concept_provider_audits_raw_response(monkeypatch):
    concept=dict(title='River',description='A river',image_prompt='A river at dawn',video_prompt='Water flows')
    calls=transport(monkeypatch,{'choices':[{'message':{'content':json.dumps(concept)}}],'conversation_url':'https://chatgpt.com/c/test'})
    payload=dict(provider='chatgpt-web',text='River',start_ms=0,end_ms=3000,visual_style='realistic',script_context='',previous_text='',next_text='')
    result=await write_concept(payload)
    assert result.title=='River'
    assert g.audit_rows()[0]['state']=='COMPLETED'
    assert 'conversation_url' in g.audit_rows()[0]['response']
    assert len([r for r in calls if r.method=='POST'])==1

@pytest.mark.asyncio
async def test_invalid_json_pauses_without_retry_and_preserves_response(monkeypatch):
    calls=transport(monkeypatch,{'choices':[{'message':{'content':'unfinished response'}}]})
    with pytest.raises(g.GatewayReviewRequired):
        await g.complete('prompt',validate=parse_concept)
    with pytest.raises(g.GatewayReviewRequired):
        await g.complete('second prompt')
    assert g.blocked()
    assert len([r for r in calls if r.method=='POST'])==1
    assert 'unfinished response' in g.audit_rows()[0]['response']
    await g.reset()
    assert not g.blocked()

@pytest.mark.asyncio
async def test_gateway_failure_remains_review_required_across_reads(monkeypatch):
    transport(monkeypatch,{'error':'Extension disconnected'},502)
    with pytest.raises(g.GatewayReviewRequired):
        await g.complete('prompt')
    assert (await g.status())['needsReview']
    assert g.audit_rows()[0]['state']=='NEEDS_REVIEW'
