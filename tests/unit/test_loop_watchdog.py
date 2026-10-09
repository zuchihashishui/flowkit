import asyncio
import logging
import time

import pytest
from agent.services.loop_watchdog import LoopWatchdog


@pytest.mark.asyncio
async def test_watchdog_records_blocking_stack_and_stops(caplog):
    with caplog.at_level(logging.ERROR):
        with LoopWatchdog(threshold=.04, interval=.01, cooldown=10) as watch:
            # A synchronous wait blocks the event loop, like a slow disk/SQLite call.
            time.sleep(.15)
        await asyncio.to_thread(watch.thread.join, 1)
    assert not watch.thread.is_alive()
    assert 'Backend event loop blocked' in caplog.text
    assert 'test_watchdog_records_blocking_stack_and_stops' in caplog.text
    assert sum('Backend event loop blocked' in r.message for r in caplog.records) == 1


@pytest.mark.asyncio
async def test_async_worker_wait_does_not_report_a_blocked_loop(caplog):
    with caplog.at_level(logging.ERROR):
        with LoopWatchdog(threshold=.1, interval=.01) as watch:
            await asyncio.sleep(.2)
        await asyncio.to_thread(watch.thread.join, 1)
    assert 'Backend event loop blocked' not in caplog.text
