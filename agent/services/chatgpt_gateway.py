"""Durable ChatGPT queue, shared by Desktop and storyboard, with pool commit ACKs."""
import asyncio
from contextlib import contextmanager
import json
import sqlite3
import time
import uuid
import httpx
from agent.config import BASE_DIR

URL = 'http://127.0.0.1:18790'
STORE = BASE_DIR / 'chatgpt_jobs.db'
_inflight = set()
DEFAULTS = {'workers': 3, 'timeout_seconds': 180, 'temporary': True, 'paused': False}

class GatewayReviewRequired(RuntimeError):
    pass

class GatewayBusy(RuntimeError):
    """Known not submitted; scheduler may keep this job queued."""

@contextmanager
def db():
    c = sqlite3.connect(STORE, timeout=10)
    c.row_factory = sqlite3.Row
    c.execute('CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, state TEXT, prompt TEXT, response TEXT, error TEXT, created REAL)')
    c.execute('CREATE TABLE IF NOT EXISTS chat_settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)')
    c.execute('''CREATE TABLE IF NOT EXISTS chat_queue (
        id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
        prompt TEXT NOT NULL, model TEXT, state TEXT NOT NULL, answer TEXT, error TEXT,
        audit_id TEXT, created REAL NOT NULL, updated REAL NOT NULL)''')
    try:
        with c:
            yield c
    finally:
        c.close()

def settings():
    with db() as c:
        row = c.execute('SELECT value FROM chat_settings WHERE id=1').fetchone()
    return {**DEFAULTS, **(json.loads(row['value']) if row else {})}

def update_settings(values):
    value = {**settings(), **values}
    with db() as c:
        c.execute('INSERT OR REPLACE INTO chat_settings VALUES(1,?)', (json.dumps(value),))
    return value

def audit_rows():
    with db() as c:
        return [dict(r) for r in c.execute('SELECT * FROM requests ORDER BY created DESC LIMIT 500')]

def blocked():
    with db() as c:
        return c.execute("SELECT 1 FROM requests WHERE state='NEEDS_REVIEW' LIMIT 1").fetchone() is not None

def queue_rows():
    with db() as c:
        return [dict(r) for r in c.execute('SELECT * FROM chat_queue ORDER BY created DESC, ordinal LIMIT 1000')]

def enqueue(prompts, model='auto'):
    batch = str(uuid.uuid4())
    now = time.time()
    ids = []
    with db() as c:
        for ordinal, prompt in enumerate(prompts, 1):
            jid = str(uuid.uuid4())
            c.execute('INSERT INTO chat_queue(id,batch_id,ordinal,prompt,model,state,created,updated) VALUES(?,?,?,?,?,?,?,?)',
                      (jid,batch,ordinal,prompt,model,'QUEUED',now,now))
            ids.append(jid)
    return {'batch_id': batch, 'ids': ids}

def cancel_jobs(ids):
    with db() as c:
        count = 0
        for jid in set(ids):
            count += c.execute("UPDATE chat_queue SET state='CANCELLED',updated=? WHERE id=? AND state='QUEUED'", (time.time(),jid)).rowcount
    return {'cancelled': count}

def retry_jobs(ids):
    # Explicit user action only: an uncertain request may already have completed remotely.
    count = 0
    with db() as c:
        for jid in set(ids):
            row = c.execute("SELECT * FROM chat_queue WHERE id=? AND state IN ('FAILED','NEEDS_REVIEW','CANCELLED')",(jid,)).fetchone()
            if row:
                c.execute('INSERT INTO chat_queue(id,batch_id,ordinal,prompt,model,state,created,updated) VALUES(?,?,?,?,?,?,?,?)',
                          (str(uuid.uuid4()),str(uuid.uuid4()),1,row['prompt'],row['model'],'QUEUED',time.time(),time.time()))
                count += 1
    return {'queued': count}

async def status():
    config = settings()
    try:
        async with httpx.AsyncClient(trust_env=False, timeout=3) as client:
            r = await client.get(URL+'/health')
            r.raise_for_status()
            info = r.json()
        valid = info.get('service') == 'flowkit-chatgpt-gateway' and info.get('protocol') == 2
        idle = sum(w.get('state') == 'IDLE' for w in info.get('workers', [])[:config['workers']])
        slots = min(idle, max(0,config['workers']-len(_inflight))) if valid and info.get('enabled') and not info.get('needsReview') and not info.get('inspecting') and not config['paused'] else 0
        return {**info, 'available':valid,'availableSlots':slots,'settings':config,'hasReviewJobs':blocked()}
    except Exception as e:
        return {'available':False,'extensionConnected':False,'availableSlots':0,'settings':config,'hasReviewJobs':blocked(),'error':str(e)}

async def reset():
    if _inflight:
        raise GatewayReviewRequired('Requests are still running. Wait for them to finish.')
    async with httpx.AsyncClient(trust_env=False, timeout=8) as client:
        r = await client.post(URL+'/review/reset')
        r.raise_for_status()
    with db() as c:
        c.execute("UPDATE requests SET state='REVIEWED' WHERE state IN ('RUNNING','NEEDS_REVIEW')")
    return {'ok':True}

async def commit(request_id, ok):
    async with httpx.AsyncClient(trust_env=False, timeout=8) as client:
        r = await client.post(URL+'/commit', json={'request_id':request_id,'ok':ok})
        r.raise_for_status()

async def complete(prompt, model=None, validate=None, job_id=None):
    config = settings()
    if config['paused'] or len(_inflight) >= config['workers']:
        raise GatewayBusy('ChatGPT queue is paused or all workers are busy.')
    rid = str(uuid.uuid4())
    _inflight.add(rid)  # No await between checking capacity and reserving it.
    remote_id = None
    audited = False
    saved = False
    try:
        # Gateway atomically selects a free tab. A 409/503 means no submission.
        with db() as c:
            c.execute('INSERT INTO requests VALUES(?,?,?,?,?,?)',(rid,'RUNNING',prompt,None,None,time.time()))
            if job_id:
                c.execute('UPDATE chat_queue SET audit_id=? WHERE id=?',(rid,job_id))
        audited = True
        async with httpx.AsyncClient(trust_env=False, timeout=config['timeout_seconds']+90) as client:
            response = await client.post(URL+'/v1/chat/completions',json={
                'messages':[{'role':'user','content':prompt}], 'model':model or 'auto',
                'timeout':config['timeout_seconds']*1000,'workers':config['workers'],'temporary':config['temporary']})
        raw = response.text
        with db() as c:
            c.execute('UPDATE requests SET response=? WHERE id=?',(raw,rid))
        result = response.json()
        if response.status_code in (409,503) and result.get('not_submitted'):
            with db() as c:
                c.execute("UPDATE requests SET state='NOT_SUBMITTED',error=? WHERE id=?",(result.get('error'),rid))
            raise GatewayBusy(result.get('error','No available worker'))
        remote_id = result.get('id') or result.get('request_id')
        response.raise_for_status()
        text = result['choices'][0]['message']['content']
        if not isinstance(text,str) or not text.strip():
            raise ValueError('ChatGPT returned an empty answer')
        value = validate(text) if validate else text
        # Commit the durable result before telling the extension to reuse the tab.
        with db() as c:
            c.execute("UPDATE requests SET state='COMPLETED' WHERE id=?",(rid,))
            if job_id:
                c.execute("UPDATE chat_queue SET state='COMPLETED',answer=?,error=NULL,updated=? WHERE id=?",(text,time.time(),job_id))
        saved = True
        try:
            await commit(remote_id, True)
        except Exception as e:
            with db() as c:
                c.execute('UPDATE requests SET error=? WHERE id=?',('Result saved; worker release unconfirmed: '+str(e),rid))
        return value
    except GatewayBusy:
        raise
    except BaseException as e:
        if audited and not saved:
            with db() as c:
                c.execute("UPDATE requests SET state='NEEDS_REVIEW',error=? WHERE id=?",(str(e)[:2000],rid))
        if remote_id and not saved:
            try:
                await commit(remote_id, False)
            except Exception:
                pass
        if isinstance(e,asyncio.CancelledError):
            raise
        raise GatewayReviewRequired(f'ChatGPT request {rid} needs review: {e}. Check Request History and the worker tab.') from e
    finally:
        _inflight.discard(rid)

async def process_job(job):
    with db() as c:
        if not c.execute("UPDATE chat_queue SET state='RUNNING',updated=? WHERE id=? AND state='QUEUED'",(time.time(),job['id'])).rowcount:
            return
    try:
        await complete(job['prompt'],job['model'],job_id=job['id'])
    except GatewayBusy:
        with db() as c:
            c.execute("UPDATE chat_queue SET state='QUEUED',updated=? WHERE id=?",(time.time(),job['id']))
    except (GatewayReviewRequired, asyncio.CancelledError) as e:
        with db() as c:
            c.execute("UPDATE chat_queue SET state='NEEDS_REVIEW',error=?,updated=? WHERE id=? AND state='RUNNING'",(str(e) or 'App stopped during generation',time.time(),job['id']))
        if isinstance(e,asyncio.CancelledError):
            raise

def recover():
    with db() as c:
        legacy_review = not c.execute('SELECT 1 FROM chat_settings WHERE id=1').fetchone() and c.execute("SELECT 1 FROM requests WHERE state='NEEDS_REVIEW' LIMIT 1").fetchone() is not None
        old = c.execute("UPDATE requests SET state='NEEDS_REVIEW',error='Backend restarted during generation' WHERE state='RUNNING'").rowcount
        old += c.execute("UPDATE chat_queue SET state='NEEDS_REVIEW',error='Backend restarted during generation' WHERE state='RUNNING'").rowcount
    if old or legacy_review:
        update_settings({'paused':True})

async def run():
    recover()
    tasks = {}
    try:
        while True:
            for jid, task in list(tasks.items()):
                if task.done():
                    task.result()
                    del tasks[jid]
            info = await status()
            count = min(info.get('availableSlots',0),3-len(tasks))
            if count:
                with db() as c:
                    jobs = [dict(r) for r in c.execute("SELECT * FROM chat_queue WHERE state='QUEUED' ORDER BY created,ordinal LIMIT ?",(count,))]
                for job in jobs:
                    if job['id'] not in tasks:
                        tasks[job['id']] = asyncio.create_task(process_job(job))
            await asyncio.sleep(1)
    finally:
        for task in tasks.values():
            task.cancel()
        await asyncio.gather(*tasks.values(),return_exceptions=True)

async def inspect_tabs(kind, model='auto'):
    config = settings()
    if _inflight:
        raise GatewayBusy('Pause the queue and wait for active jobs before checking tabs.')
    async with httpx.AsyncClient(trust_env=False, timeout=25) as client:
        r = await client.post(URL+'/inspect', json={'kind':kind,'model':model,
                              'workers':config['workers'],'temporary':config['temporary']})
        if r.status_code != 200:
            try:
                detail = r.json().get('error', r.text)
            except ValueError:
                detail = r.text
            raise GatewayBusy(str(detail))
        return r.json()
