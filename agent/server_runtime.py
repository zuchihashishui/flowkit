"""Start the backend with subprocess support on Windows as well as Unix."""
import asyncio
import logging
import sys

import uvicorn

IS_WINDOWS = sys.platform == 'win32'
logger = logging.getLogger(__name__)


def run_server(app, *, host, port, reload=False):
    if not IS_WINDOWS:
        return uvicorn.run(app, host=host, port=port, reload=reload,
                           reload_excludes=['*.db', '*.db-wal', '*.db-shm', 'output/*'])

    # Let asyncio own the loop, rather than Server.run() selecting a Windows
    # Selector loop. WhisperX, FFmpeg and other workers require Proactor pipes.
    # A single process also keeps the durable job queues from running twice.
    if reload:
        logger.warning('Windows backend hot reload is disabled to preserve subprocess support. Restart after code changes.')
    config = uvicorn.Config(app, host=host, port=port, loop='none', workers=1, reload=False)
    server = uvicorn.Server(config)
    previous_policy = asyncio.get_event_loop_policy()
    try:
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
        logger.info('Starting Windows backend with Proactor event loop and one worker')
        return asyncio.run(server.serve())
    finally:
        asyncio.set_event_loop_policy(previous_policy)
