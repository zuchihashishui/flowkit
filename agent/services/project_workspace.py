"""One project is one production; keep the existing video ID as an internal key."""
import uuid
from fastapi import HTTPException
from agent.db.schema import get_db, _db_lock


async def ensure(project_id, orientation=None):
    async with _db_lock:
        db = await get_db()
        try:
            await db.execute('BEGIN IMMEDIATE')
            project = await (await db.execute("SELECT id,name FROM project WHERE id=? AND status!='DELETED'", (project_id,))).fetchone()
            if not project:
                raise HTTPException(404, 'Project not found. Refresh Projects.')
            rows = await (await db.execute('SELECT * FROM video WHERE project_id=? ORDER BY created_at,id', (project_id,))).fetchall()
            if len(rows) > 1:
                raise HTTPException(409, f'This older project contains {len(rows)} video collections and needs a data migration before using one-project/one-video mode. All existing data is retained; no collection was selected, merged or deleted.')
            if rows:
                vid = rows[0]['id']
                await db.execute('UPDATE video SET title=? WHERE id=?', (project['name'], vid))
            else:
                vid = str(uuid.uuid4())
                await db.execute('INSERT INTO video(id,project_id,title,orientation) VALUES(?,?,?,?)',
                                 (vid, project_id, project['name'], orientation or 'HORIZONTAL'))
            result = await (await db.execute('SELECT * FROM video WHERE id=?', (vid,))).fetchone()
            await db.commit()
            return dict(result)
        except BaseException:
            await db.rollback()
            raise
