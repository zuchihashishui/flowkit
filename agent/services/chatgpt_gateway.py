"""Local Draivix adapter with durable audit and explicit recovery after uncertainty."""
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
_lock = asyncio.Lock()

class GatewayReviewRequired(RuntimeError):
    pass

@contextmanager
def db():
    c = sqlite3.connect(STORE)
    c.row_factory = sqlite3.Row
    c.execute('CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, state TEXT, prompt TEXT, response TEXT, error TEXT, created REAL)')
    try:
        with c:
            yield c
    finally:
        c.close()

def audit_rows():
    with db() as c:
        return [dict(r) for r in c.execute('SELECT * FROM requests ORDER BY created DESC LIMIT 100')]

def blocked():
    with db() as c:
        return c.execute("SELECT 1 FROM requests WHERE state IN ('RUNNING','NEEDS_REVIEW') LIMIT 1").fetchone() is not None

async def status():
    try:
        async with httpx.AsyncClient(trust_env=False, timeout=3) as client:
            r = await client.get(URL+'/health')
            r.raise_for_status()
            info = r.json()
        valid = info.get('service') == 'flowkit-chatgpt-gateway' and info.get('protocol') == 1
        return {**info, 'available': valid, 'needsReview': blocked() or bool(info.get('needsReview'))}
    except Exception as e:
        return {'available': False, 'extensionConnected': False, 'needsReview': blocked(), 'error': str(e)}

async def reset():
    if _lock.locked():
        raise GatewayReviewRequired('A request is still running. Wait for it to finish.')
    async with httpx.AsyncClient(trust_env=False, timeout=5) as client:
        r = await client.post(URL+'/review/reset')
        r.raise_for_status()
    with db() as c:
        c.execute("UPDATE requests SET state='REVIEWED' WHERE state IN ('RUNNING','NEEDS_REVIEW')")
    return {'ok': True}

async def complete(prompt, model=None, validate=None):
    async with _lock:
        s = await status()
        if not s.get('available') or not s.get('extensionConnected') or s.get('busy') or s.get('needsReview'):
            raise GatewayReviewRequired('ChatGPT gateway is disconnected, busy or needs review. Check Settings → ChatGPT Web.')
        rid = str(uuid.uuid4())
        with db() as c:
            c.execute('INSERT INTO requests VALUES(?,?,?,?,?,?)',(rid,'RUNNING',prompt,None,None,time.time()))
        try:
            async with httpx.AsyncClient(trust_env=False, timeout=620) as client:
                response = await client.post(URL+'/v1/chat/completions', json={'messages':[{'role':'user','content':prompt}], 'model':model or 'auto','timeout':180000})
            raw = response.text
            with db() as c:
                c.execute('UPDATE requests SET response=? WHERE id=?',(raw,rid))
            response.raise_for_status()
            result = response.json()
            text = result['choices'][0]['message']['content']
            if not text.strip():
                raise ValueError('ChatGPT returned an empty answer')
            value = validate(text) if validate else text
            with db() as c:
                c.execute("UPDATE requests SET state='COMPLETED' WHERE id=?",(rid,))
            return value
        except BaseException as e:
            with db() as c:
                c.execute("UPDATE requests SET state='NEEDS_REVIEW',error=? WHERE id=?",(str(e)[:2000],rid))
            if isinstance(e, asyncio.CancelledError):
                raise
            raise GatewayReviewRequired(f'ChatGPT request {rid} needs review: {e}. Original response is saved in Settings.') from e
