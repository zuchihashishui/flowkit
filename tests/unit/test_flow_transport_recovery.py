"""Transport recovery must not replay a possibly accepted browser write."""
import json
from unittest.mock import AsyncMock, patch

import pytest

from agent.services import flow_batch as fb
from agent.services.flow_client import FlowClient
from agent.worker.processor import _handle_failure


class Peer:
    def __init__(self, client, behavior):
        self.client = client
        self.behavior = behavior
        self.calls = []

    async def send(self, payload):
        message = json.loads(payload)
        self.calls.append(message)
        if self.behavior == 'disconnect':
            self.client.clear_extension(self)
        elif self.behavior == 'timeout':
            return
        else:
            result = ({'error': self.behavior} if self.behavior != 'success'
                      else {'status': 200, 'data': 'saved response'})
            await self.client.handle_message({'id': message['id'], **result}, self)


def pair(behavior):
    client = FlowClient()
    first, second = Peer(client, behavior), Peer(client, 'success')
    client.set_extension(first)
    client.set_extension(second)
    return client, first, second


@pytest.mark.parametrize('rpcid', [
    fb.RPC_GEN_IMAGE, fb.RPC_GEN_VIDEO, fb.RPC_GEN_VIDEO_TEXT,
    fb.RPC_GEN_VIDEO_FIRST_LAST, fb.RPC_GEN_VIDEO_REFERENCES,
    fb.RPC_UPLOAD_IMAGE, fb.RPC_UPSCALE_IMAGE, fb.RPC_CREATE_PROJECT,
    'future-write-rpc',
])
@pytest.mark.parametrize('behavior', ['disconnect', 'timeout', 'Extension disconnected'])
async def test_uncertain_write_is_never_replayed_in_another_profile(rpcid, behavior):
    client, first, second = pair(behavior)
    result = await client._send('batch_rpc', {'rpcid': rpcid, 'freq': '[]'}, timeout=0.005)
    assert 'SUBMISSION_UNCERTAIN' in result['error']
    assert len(first.calls) == 1
    assert not second.calls
    assert not client._pending and not client._pending_ws


@pytest.mark.parametrize('rpcid', [fb.RPC_OPERATION, fb.RPC_PROJECT_MEDIA, fb.RPC_MEDIA])
async def test_read_only_rpc_keeps_disconnect_failover(rpcid):
    client, first, second = pair('disconnect')
    result = await client._send('batch_rpc', {'rpcid': rpcid, 'freq': '[]'})
    assert result['data'] == 'saved response'
    assert len(first.calls) == len(second.calls) == 1


@pytest.mark.parametrize('error', ['NO_FLOW_TAB', 'NO_AT_TOKEN', 'FLOW_TAB_DISCARDED'])
async def test_known_pre_submission_failure_can_use_another_profile(error):
    client, first, second = pair(error)
    result = await client._send('batch_rpc', {'rpcid': fb.RPC_GEN_IMAGE, 'freq': '[]'})
    assert result['data'] == 'saved response'
    assert len(first.calls) == len(second.calls) == 1


@pytest.mark.parametrize('error', [
    'SUBMISSION_UNCERTAIN: Extension disconnected. Check Flow before retrying.',
    'SUBMISSION_UNCERTAIN: Timeout waiting for batch_rpc. Check Flow before retrying.',
])
async def test_legacy_worker_stops_uncertain_submission_instead_of_auto_retry(error):
    req = {'id': 'request-1', 'type': 'GENERATE_IMAGE', 'scene_id': 'scene-1',
           'orientation': 'VERTICAL', 'retry_count': 0}
    with patch('agent.worker.processor.crud') as crud:
        crud.update_request = AsyncMock()
        crud.update_scene = AsyncMock()
        await _handle_failure(req['id'], req, {'error': error})
    crud.update_request.assert_awaited_once_with('request-1', status='FAILED', error_message=error)
    crud.update_scene.assert_awaited_once_with('scene-1', vertical_image_status='FAILED')


@pytest.mark.asyncio
async def test_project_urls_are_request_local_and_never_sent_to_an_old_extension():
    import asyncio
    from agent.services.project_settings import flow_page_url
    client, old, peer=pair('success')
    client._extensions[peer]['project_urls']=True
    async def dispatch(url):
        token=flow_page_url.set(url)
        try:return await client._send('batch_rpc',{'rpcid':fb.RPC_GEN_IMAGE,'freq':'[]'})
        finally:flow_page_url.reset(token)
    urls=['https://flow.google.com/project/'+p for p in ['11111111-2222-3333-4444-555555555555','aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']]
    await asyncio.gather(*(dispatch(url) for url in urls))
    assert not old.calls
    assert {m['params']['pageUrl'] for m in peer.calls}==set(urls)
    assert flow_page_url.get() is None
    client._extensions[peer]['project_urls']=False
    result=await dispatch(urls[0]);assert 'Reload' in result['error'];assert len(peer.calls)==2
