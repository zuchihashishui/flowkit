from fastapi import FastAPI
from fastapi.testclient import TestClient
from unittest.mock import AsyncMock
from agent.api import chatgpt


def client():
    app = FastAPI()
    app.include_router(chatgpt.router, prefix='/api')
    return TestClient(app)


def test_message_calls_shared_gateway(monkeypatch):
    complete = AsyncMock(return_value='Example answer')
    monkeypatch.setattr(chatgpt.g, 'complete', complete)
    r = client().post('/api/chatgpt/message', json={'prompt': 'My prompt', 'model': ''})
    assert r.status_code == 200
    assert r.json() == {'response': 'Example answer'}
    complete.assert_awaited_once_with('My prompt', 'auto')


def test_invalid_prompt_never_submitted(monkeypatch):
    complete = AsyncMock()
    monkeypatch.setattr(chatgpt.g, 'complete', complete)
    for prompt in ['', '  ', 'x' * 20001]:
        assert client().post('/api/chatgpt/message', json={'prompt': prompt}).status_code == 422
    complete.assert_not_awaited()


def test_gateway_review_error_is_visible(monkeypatch):
    monkeypatch.setattr(chatgpt.g, 'complete', AsyncMock(side_effect=chatgpt.g.GatewayReviewRequired('Review required')))
    r = client().post('/api/chatgpt/message', json={'prompt': 'Hello'})
    assert r.status_code == 409
    assert r.json()['detail'] == 'Review required'


def test_batch_api_limits_and_persistence(tmp_path,monkeypatch):
    monkeypatch.setattr(chatgpt.g,'STORE',tmp_path/'queue.db')
    c=client()
    result=c.post('/api/chatgpt/queue',json={'prompts':[f'Prompt {i}' for i in range(150)]})
    assert result.status_code==200 and len(result.json()['ids'])==150
    assert len(c.get('/api/chatgpt/queue').json()['jobs'])==150
    assert c.post('/api/chatgpt/queue',json={'prompts':['x']*201}).status_code==422
    assert c.post('/api/chatgpt/config',json={'workers':4,'timeout_seconds':180}).status_code==422
    config=c.post('/api/chatgpt/config',json={'workers':2,'timeout_seconds':600,'temporary':True,'paused':True})
    assert config.status_code==200 and chatgpt.g.settings()['paused']


def test_inspection_routes_forward_without_generating(monkeypatch):
    inspect = AsyncMock(return_value={'passed': True, 'reports': []})
    complete = AsyncMock()
    monkeypatch.setattr(chatgpt.g, 'inspect_tabs', inspect)
    monkeypatch.setattr(chatgpt.g, 'complete', complete)
    c = client()
    assert c.post('/api/chatgpt/preflight', json={'model':'GPT-6 Astra :: high'}).json()['passed']
    inspect.assert_awaited_with('preflight', 'GPT-6 Astra :: high')
    assert c.post('/api/chatgpt/models', json={}).status_code == 200
    inspect.assert_awaited_with('discoverModels')
    complete.assert_not_awaited()
    inspect.side_effect = chatgpt.g.GatewayBusy('Worker busy')
    assert c.post('/api/chatgpt/models', json={}).status_code == 409
