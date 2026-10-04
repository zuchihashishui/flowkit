"""Project/video selection never creates, renames or combines existing videos."""
import uuid
from fastapi import HTTPException
from agent.db.schema import get_db, _db_lock


async def _project(db, project_id):
    row = await (await db.execute("SELECT id,name FROM project WHERE id=? AND status!='DELETED'", (project_id,))).fetchone()
    if not row:
        raise HTTPException(404, 'Project not found. Refresh Projects.')
    return row


async def select(project_id, video_id=None):
    async with _db_lock:
        db = await get_db()
        await _project(db, project_id)
        from agent.services.media_ownership import backfill
        await backfill(project_id)
        rows = [dict(r) for r in await (await db.execute('SELECT * FROM video WHERE project_id=? ORDER BY display_order,created_at,id', (project_id,))).fetchall()]
        selected = next((r for r in rows if r['id']==video_id), None)
        if video_id and not selected:
            raise HTTPException(409, 'This video does not belong to the selected project. Refresh the video list.')
        if not video_id and len(rows)==1:
            selected=rows[0]
        return {'project_id':project_id,'video_id':selected['id'] if selected else None,
                'title':selected['title'] if selected else None,'videos':rows,'protocol':3}


async def ensure(project_id, orientation=None):
    """Compatibility for callers omitting video_id: resolve only an unambiguous video."""
    result = await select(project_id)
    if not result['video_id']:
        raise HTTPException(409, 'Select or create a video in Project. This request needs an explicit video_id.')
    return result['videos'][0]


async def create(body):
    async with _db_lock:
        db = await get_db()
        await _project(db, body.project_id)
        from agent.services.media_ownership import backfill
        # Fix old job ownership before this project gains another video.
        await backfill(body.project_id)
        vid=str(uuid.uuid4())
        try:
            await db.execute('INSERT INTO video(id,project_id,title,description,display_order,orientation) VALUES(?,?,?,?,?,?)',
                             (vid,body.project_id,body.title,body.description,body.display_order,body.orientation or 'HORIZONTAL'))
            await db.commit()
        except BaseException:
            await db.rollback()
            raise
        return dict(await (await db.execute('SELECT * FROM video WHERE id=?', (vid,))).fetchone())
