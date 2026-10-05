import json
import httpx
import pytest
from agent.services import chatgpt_gateway as gateway

@pytest.mark.asyncio
async def test_prepare_reuses_token_and_project_url(monkeypatch):
    original = httpx.AsyncClient
    def handler(request):
        body = json.loads(request.content)
        assert request.url.path == '/srt/prepare'
        assert body == {'pageUrl': 'https://chatgpt.com/?model=auto', 'token': '11111111-1111-1111-1111-111111111111'}
        return httpx.Response(200, json={'token': body['token'], 'tabId': 123})
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    result = await gateway.prepare_srt('https://chatgpt.com/?model=auto', '11111111-1111-1111-1111-111111111111')
    assert result['tabId'] == 123

@pytest.mark.asyncio
async def test_prepare_connection_error_is_actionable(monkeypatch):
    original = httpx.AsyncClient
    def handler(request):
        raise httpx.ConnectError('offline', request=request)
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    with pytest.raises(ValueError, match='Restart the gateway'):
        await gateway.prepare_srt('https://chatgpt.com/')
