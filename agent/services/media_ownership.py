"""Recover legacy desktop job owners from saved IDs, or a sole existing video.

Unresolvable project-wide jobs remain without video_id; never pick one of several.
"""
import json
import sqlite3
from agent.db import schema


async def backfill(project_id=None):
    from agent.api import desktop
    if not desktop.STORE.exists():
        return
    with desktop.connection() as store:
        pending=[dict(r) for r in store.execute("SELECT id,payload FROM jobs WHERE COALESCE(json_extract(payload,'$.video_id'),'')=''" +
                 (" AND json_extract(payload,'$.project_id')=?" if project_id else ''), (project_id,) if project_id else ())]
    if not pending:
        return
    if not schema.DB_PATH.exists():
        return
    with sqlite3.connect(str(schema.DB_PATH)) as db:
        db.row_factory=sqlite3.Row
        tables={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {'video','script_document','script_segment','scene'}.issubset(tables):
            return  # Standalone desktop jobs remain readable before the main DB is initialized.
        videos={r['id']:r['project_id'] for r in db.execute('SELECT id,project_id FROM video')}
        documents={r['id']:r['video_id'] for r in db.execute('SELECT id,video_id FROM script_document')}
        segments={r['id']:documents.get(r['document_id']) for r in db.execute('SELECT id,document_id FROM script_segment')}
        scenes={r['id']:r['video_id'] for r in db.execute('SELECT id,video_id FROM scene')}
    changes=[]
    for row in pending:
        p=json.loads(row['payload']);pid=p.get('project_id')
        refs=[lookup.get(p[key]) for key,lookup in [('document_id',documents),('segment_id',segments),('scene_id',scenes)] if p.get(key)]
        choices=set(refs) if refs else {vid for vid,owner in videos.items() if owner==pid}
        if len(choices)!=1:
            continue
        vid=next(iter(choices))
        if not vid or videos.get(vid)!=pid:
            continue
        p['video_id']=vid
        changes.append((json.dumps(p,ensure_ascii=False),row['id'],row['payload']))
    if changes:
        with desktop.connection() as store:
            store.executemany('UPDATE jobs SET payload=? WHERE id=? AND payload=?',changes)
