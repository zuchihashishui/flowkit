import json
from types import SimpleNamespace
from unittest.mock import AsyncMock
import httpx
import pytest
from agent.services import browser_lifecycle as life, chatgpt_gateway as chat
from agent.api import desktop, storyboard
from agent.services import flow_client
from agent.worker import processor


@pytest.fixture
def state(tmp_path, monkeypatch):
    monkeypatch.setattr(life, '_flow_work', {})
    monkeypatch.setattr(desktop, 'STORE', tmp_path / 'desktop.db')
    monkeypatch.setattr(chat, 'STORE', tmp_path / 'chat.db')
    monkeypatch.setattr(chat, '_cleanup_pending', False)
    monkeypatch.setattr(chat, '_inflight', set())
    peer = SimpleNamespace(send=AsyncMock())
    client = SimpleNamespace(connected=True, _pending={}, _extensions=[peer], close_idle_windows=peer.send)
    peer.send.return_value = True
    controller = SimpleNamespace(active_count=0)
    monkeypatch.setattr(flow_client, 'get_flow_client', lambda: client)
    monkeypatch.setattr(processor, 'get_worker_controller', lambda: controller)
    query = AsyncMock(return_value=[])
    monkeypatch.setattr(storyboard, 'query', query)
    return peer, client, controller, query


@pytest.mark.asyncio
async def test_flow_waits_for_all_parallel_jobs_and_durable_downloads(state):
    peer, client, controller, query = state
    for jid in ('a', 'b', 'c'):
        life.flow_started('desktop', jid)
    for jid in ('c', 'a'):
        life.flow_saved('desktop', jid)
    await life.close_idle_flow_tabs()
    peer.send.assert_not_awaited()
    life.flow_saved('desktop', 'b')
    with desktop.connection() as db:
        db.execute("INSERT INTO jobs(id,payload,state,created) VALUES(?,?,?,0)", ('download', json.dumps({'kind':'video'}), 'DOWNLOADING'))
    await life.close_idle_flow_tabs()
    peer.send.assert_not_awaited()
    desktop.update('download', state='COMPLETED')
    await life.close_idle_flow_tabs()
    peer.send.assert_awaited_once_with()
    assert not life._flow_work
    await life.close_idle_flow_tabs()
    assert peer.send.await_count == 1


@pytest.mark.asyncio
async def test_flow_keeps_failed_and_active_work_for_review(state):
    peer, client, controller, query = state
    life.flow_started('request', 'failed')
    life.flow_started('desktop', 'saved')
    life.flow_saved('desktop', 'saved')
    await life.close_idle_flow_tabs()
    peer.send.assert_not_awaited()
    # Explicit retry saves the missing result.
    life.flow_saved('request', 'failed')
    client._pending['rpc'] = object()
    await life.close_idle_flow_tabs()
    peer.send.assert_not_awaited()
    client._pending.clear()
    query.return_value = [{'id':'queued'}]
    await life.close_idle_flow_tabs()
    peer.send.assert_not_awaited()
    query.return_value = []
    controller.active_count = 1
    await life.close_idle_flow_tabs()
    peer.send.assert_not_awaited()
    controller.active_count = 0
    await life.close_idle_flow_tabs()
    peer.send.assert_awaited_once()


@pytest.mark.asyncio
async def test_flow_never_closes_tabs_on_startup_or_before_any_result_saved(state):
    await life.close_idle_flow_tabs()
    state[0].send.assert_not_awaited()


@pytest.mark.asyncio
async def test_chat_cleanup_waits_for_regular_queue_and_scene_concepts(state, monkeypatch):
    calls = []
    def handler(request):
        calls.append(request.url.path)
        return httpx.Response(200, json={'ok':True})
    factory = httpx.AsyncClient
    monkeypatch.setattr(chat.httpx, 'AsyncClient', lambda **kw: factory(transport=httpx.MockTransport(handler), **kw))
    chat._cleanup_pending = True
    batch = chat.enqueue(['prompt'])
    await chat.close_idle_text_workers()
    assert not calls
    with chat.db() as db:
        db.execute("UPDATE chat_queue SET state='COMPLETED'")
    state[3].return_value = [{'payload':json.dumps({'provider':'chatgpt-web'})}]
    await chat.close_idle_text_workers()
    assert not calls
    state[3].return_value = []
    chat._inflight.add('request')
    await chat.close_idle_text_workers()
    assert not calls
    chat._inflight.clear()
    await chat.close_idle_text_workers()
    assert calls == ['/workers/close']
    assert chat._cleanup_pending is False

@pytest.mark.asyncio
async def test_flow_retries_cleanup_only_until_extension_confirms(state):
    peer = state[0]
    life.flow_saved('desktop', 'saved')
    peer.send.return_value = False
    await life.close_idle_flow_tabs()
    assert life._flow_work
    peer.send.return_value = True
    await life.close_idle_flow_tabs()
    assert not life._flow_work


@pytest.mark.asyncio
async def test_flow_cleanup_ack_uses_existing_correlated_transport():
    client = flow_client.FlowClient()
    class Peer:
        async def send(self, data):
            message = json.loads(data)
            assert message['method'] == 'close_idle_tabs'
            await client.handle_message({'id':message['id'], 'result':{'closed':True}})
    peer = Peer()
    client._extensions[peer] = {}
    assert await client.close_idle_windows()
    assert not client._pending and not client._pending_ws
