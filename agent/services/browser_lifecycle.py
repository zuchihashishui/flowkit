"""Close managed Flow tabs after durable queues finish, never after submission alone."""
import json

# Only this backend session's work participates; old failed jobs are retained
# without preventing cleanup of an unrelated successful new batch.
_flow_work: dict[tuple[str, str], bool] = {}


def flow_started(source: str, job_id: str):
    _flow_work[source, job_id] = False


def flow_saved(source: str, job_id: str):
    _flow_work[source, job_id] = True


async def close_idle_flow_tabs():
    if not _flow_work or not all(_flow_work.values()):
        return
    from agent.api import desktop, storyboard
    from agent.services.flow_client import get_flow_client
    from agent.worker.processor import get_worker_controller
    client = get_flow_client()
    if not client.connected or client._pending or get_worker_controller().active_count:
        return
    with desktop.connection() as db:
        rows = db.execute("SELECT payload FROM jobs WHERE state IN ('QUEUED','RUNNING','SUBMITTING','DOWNLOADING')").fetchall()
    if any(json.loads(row['payload'])['kind'] != 'voice' for row in rows):
        return
    pending = await storyboard.query("SELECT id FROM request WHERE status IN ('PENDING','PROCESSING') LIMIT 1")
    if pending or client._pending or not all(_flow_work.values()):
        return
    # Snapshot prevents a job enqueued while sockets are being written from
    # losing its completion tracking. New RPCs wait for extension cleanup.
    saved = dict(_flow_work)
    if not await client.close_idle_windows():
        return
    for key, value in saved.items():
        if _flow_work.get(key) == value:
            _flow_work.pop(key, None)
