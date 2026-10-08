"""Resolve output locations from immutable job ownership, with legacy reads."""
import sqlite3
from contextlib import closing
from pathlib import Path
from agent.services import workflow_scope as scope


def video_directory(context):
    if not context or not context.get('video_id'):
        return None
    from agent.db import schema
    from agent.services.video_files import ROOT, child
    with closing(sqlite3.connect('file:' + Path(schema.DB_PATH).as_posix() + '?mode=ro', uri=True)) as db:
        row = db.execute('SELECT p.name,v.title,v.project_id FROM video v JOIN project p ON p.id=v.project_id WHERE v.id=?', (context['video_id'],)).fetchone()
    if not row or (context.get('project_id') and row[2] != context['project_id']):
        raise ValueError('Output video does not belong to the project.')
    return child(child(ROOT, row[0], row[2]), row[1], context['video_id'])


def owned_path(legacy, context, relative):
    legacy = Path(legacy)
    # Existing jobs/imports keep their original paths. Never split an active job
    # between two locations or move files referenced by old database records.
    if legacy.exists():
        return legacy
    folder = video_directory(context)
    if folder is None:
        return legacy
    from agent.services.video_files import destination
    return destination(folder, relative)


def remember(db, kind, rid, path):
    db.execute('CREATE TABLE IF NOT EXISTS output_locations(kind TEXT,resource_id TEXT,path TEXT NOT NULL,PRIMARY KEY(kind,resource_id))')
    db.execute('INSERT OR IGNORE INTO output_locations VALUES(?,?,?)', (kind, str(rid), str(Path(path).resolve())))


def job_directory(service, kind, jid):
    return resource_path(service, kind, jid, service.output / jid, f'{kind}/{jid}')


def resource_path(service, kind, rid, legacy, relative):
    with service.db() as db:
        db.execute('CREATE TABLE IF NOT EXISTS output_locations(kind TEXT,resource_id TEXT,path TEXT NOT NULL,PRIMARY KEY(kind,resource_id))')
        row = db.execute('SELECT path FROM output_locations WHERE kind=? AND resource_id=?', (kind,str(rid))).fetchone()
        if row:
            path = Path(row['path'])
            if not allowed(path, service.output):
                raise ValueError('Saved output path is outside output storage.')
            return path
        context = scope.ownership(db, kind, rid)
        path = owned_path(legacy, context, relative)
        if context.get('video_id'):
            remember(db, kind, rid, path)
        return path


def allowed(path, legacy_root):
    from agent.services.video_files import ROOT
    path = Path(path).resolve()
    return path.is_relative_to(Path(legacy_root).resolve()) or path.is_relative_to(ROOT.resolve())
