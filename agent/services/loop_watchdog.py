"""Log the backend thread's stack when synchronous work blocks all HTTP routes."""
import asyncio
import logging
import sys
import threading
import time
import traceback

logger = logging.getLogger(__name__)


class LoopWatchdog:
    def __init__(self, threshold=5, interval=1, cooldown=30):
        self.threshold, self.interval, self.cooldown = threshold, interval, cooldown
        self.stopped = threading.Event()
        self.handle = None

    def pulse(self):
        self.last_tick = time.monotonic()
        if not self.stopped.is_set():
            self.handle = self.loop.call_later(self.interval, self.pulse)

    def monitor(self):
        last_report = 0
        while not self.stopped.wait(self.interval):
            now = time.monotonic()
            lag = now - self.last_tick
            if lag > self.threshold and now - last_report >= self.cooldown:
                last_report = now
                frame = sys._current_frames().get(self.thread_id)
                stack = ''.join(traceback.format_stack(frame)) if frame else 'Thread stack unavailable'
                logger.error('Backend event loop blocked for %.1fs; /health may time out. Backend thread stack (no local values):\n%s', lag, stack)

    def __enter__(self):
        self.loop = asyncio.get_running_loop()
        self.thread_id = threading.get_ident()
        self.pulse()
        self.thread = threading.Thread(target=self.monitor, name='flowkit-loop-watchdog', daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.stopped.set()
        if self.handle:
            self.handle.cancel()
