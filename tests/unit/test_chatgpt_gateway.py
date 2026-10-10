"""Mock only browser transport; queue and audit persistence use real SQLite."""
import asyncio
from unittest.mock import AsyncMock
import httpx
import pytest


def transport(monkeypatch, gateway, handler):
    client_type = httpx.AsyncClient
    monkeypatch.setattr(gateway.httpx, 'AsyncClient', lambda **kw: client_type(transport=httpx.MockTransport(handler), **kw))


def completed(request):
    return httpx.Response(200, json={'id': 'remote-1', 'choices': [{'message': {'content': 'answer'}}]})


async def test_result_durable_before_ack(monkeypatch, gateway):
    jid = gateway.enqueue(['question'])['ids'][0]
    transport(monkeypatch, gateway, completed)
    async def commit(rid, ok):
        assert rid == 'remote-1' and ok is True
        assert gateway.audit_rows()[0]['state'] == 'COMPLETED'
        assert gateway.queue_rows()[0]['answer'] == 'answer'
    ack = AsyncMock(side_effect=commit)
    monkeypatch.setattr(gateway, 'commit', ack)
    assert await gateway.complete('question', job_id=jid) == 'answer'
    ack.assert_awaited_once()
    assert not gateway._inflight and not gateway._text_calls


async def test_ack_failure_keeps_saved_answer(monkeypatch, gateway):
    transport(monkeypatch, gateway, completed)
    monkeypatch.setattr(gateway, 'commit', AsyncMock(side_effect=TimeoutError('lost ACK')))
    assert await gateway.complete('question') == 'answer'
    assert gateway.audit_rows()[0]['state'] == 'COMPLETED'
    assert 'release unconfirmed' in gateway.audit_rows()[0]['error']


@pytest.mark.parametrize('status,error_type', [(400, 'GatewayNotSubmitted'), (409, 'GatewayBusy'), (503, 'GatewayBusy')])
async def test_not_submitted_is_not_uncertain(monkeypatch, gateway, status, error_type):
    transport(monkeypatch, gateway, lambda r: httpx.Response(status, json={'not_submitted': True, 'error': 'rejected'}))
    with pytest.raises(getattr(gateway, error_type)):
        await gateway.complete('question')
    assert gateway.audit_rows()[0]['state'] == 'NOT_SUBMITTED'
    assert not gateway._inflight


async def test_uncertain_failure_requires_review(monkeypatch, gateway):
    def fail(request):
        raise httpx.ReadTimeout('lost response', request=request)
    transport(monkeypatch, gateway, fail)
    with pytest.raises(gateway.GatewayReviewRequired):
        await gateway.complete('question')
    assert gateway.blocked() and not gateway._inflight


async def test_validation_failure_negative_ack(monkeypatch, gateway):
    transport(monkeypatch, gateway, completed)
    ack = AsyncMock()
    monkeypatch.setattr(gateway, 'commit', ack)
    def reject(text):
        raise ValueError('invalid SRT')
    with pytest.raises(gateway.GatewayReviewRequired):
        await gateway.complete('question', validate=reject)
    ack.assert_awaited_once_with('remote-1', False)
    assert gateway.audit_rows()[0]['state'] == 'NEEDS_REVIEW'


async def test_capacity_prevents_duplicate_dispatch(monkeypatch, gateway):
    gateway.update_settings({'workers': 1})
    entered, release = asyncio.Event(), asyncio.Event()
    async def handler(request):
        entered.set()
        await release.wait()
        return completed(request)
    transport(monkeypatch, gateway, handler)
    monkeypatch.setattr(gateway, 'commit', AsyncMock())
    task = asyncio.create_task(gateway.complete('first'))
    try:
        await asyncio.wait_for(entered.wait(), 2)
        with pytest.raises(gateway.GatewayBusy):
            await gateway.complete('second')
        assert len(gateway.audit_rows()) == 1
    finally:
        release.set()
        await task
    assert not gateway._inflight


@pytest.mark.parametrize('exception,state', [('GatewayBusy', 'QUEUED'), ('GatewayNotSubmitted', 'FAILED'), ('GatewayReviewRequired', 'NEEDS_REVIEW')])
async def test_dispatch_failure_states(monkeypatch, gateway, exception, state):
    gateway.enqueue(['question'])
    monkeypatch.setattr(gateway, 'complete', AsyncMock(side_effect=getattr(gateway, exception)('test')))
    await gateway.process_job(gateway.queue_rows()[0])
    assert gateway.queue_rows()[0]['state'] == state


async def test_cancel_retry_and_no_dispatch(monkeypatch, gateway):
    jid = gateway.enqueue(['question'])['ids'][0]
    assert gateway.cancel_jobs([jid, jid]) == {'cancelled': 1}
    mock = AsyncMock()
    monkeypatch.setattr(gateway, 'complete', mock)
    await gateway.process_job(gateway.queue_rows()[0])
    mock.assert_not_awaited()
    assert gateway.retry_jobs([jid, jid]) == {'queued': 1}
    assert {r['state'] for r in gateway.queue_rows()} == {'CANCELLED', 'QUEUED'}


def test_restart_quarantines_without_resubmission(gateway):
    ids = gateway.enqueue(['running', 'queued'])['ids']
    with gateway.db() as db:
        db.execute("UPDATE chat_queue SET state='RUNNING' WHERE id=?", (ids[0],))
    gateway.recover()
    assert [r['state'] for r in gateway.queue_rows()] == ['NEEDS_REVIEW', 'QUEUED']
    assert gateway.settings()['paused'] is True
