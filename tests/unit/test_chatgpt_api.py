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
