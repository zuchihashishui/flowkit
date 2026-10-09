"""Explicit deletion of a project/video and its local database records.

Managed outputs, ownership, history and main database rows are removed together.
Nothing is resubmitted or cancelled.
"""
import json
import sqlite3
import uuid

from fastapi import HTTPException
from agent.db import schema
from agent.services import workflow_scope as scope

FINISHED = {'COMPLETED', 'FAILED', 'CANCELLED', 'STALE', 'NEEDS_REVIEW'}


async def delete(*, project_id=None, video_id=None):
    from agent.services import video_files
    await schema.get_db()
    # Same lock order as the file organizer, so a late snapshot cannot recreate
    # a folder between staging files and committing database deletion.
    async with video_files._lock:
        async with schema._db_lock:
            return _delete(project_id, video_id)


def _delete(project_id, video_id):
    from agent.api import desktop, storyboard
    registry = scope.providers()
    # Initialize/migrate stores before opening the deletion transaction.
    for service in dict.fromkeys(item[0] for item in registry.values()):
        with service.db():
            pass
    with desktop.connection():
        pass
    db = sqlite3.connect(schema.DB_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    moved = []
    token = uuid.uuid4().hex
    try:
        db.execute('PRAGMA foreign_keys=ON')
        aliases = {}
        for store in dict.fromkeys([str(desktop.STORE), *(str(s.store) for s, _ in registry.values())]):
            alias = 'store' + str(len(aliases))
            db.execute(f'ATTACH DATABASE ? AS {alias}', (store,))
            aliases[store] = alias
        db.execute('BEGIN IMMEDIATE')
        table, rid = ('video', video_id) if video_id else ('project', project_id)
        if not db.execute(f'SELECT 1 FROM {table} WHERE id=?', (rid,)).fetchone():
            raise HTTPException(404, table.capitalize() + ' not found')
        db.execute('CREATE TEMP TABLE target_videos(id TEXT PRIMARY KEY)')
        db.execute('INSERT INTO target_videos SELECT id FROM video WHERE ' +
                   ('id=?' if video_id else 'project_id=?'), (rid,))
        for target, query in {
            'documents': 'SELECT id FROM script_document WHERE video_id IN (SELECT id FROM target_videos)',
            'segments': 'SELECT id FROM script_segment WHERE document_id IN (SELECT id FROM target_documents)',
            'scenes': 'SELECT id FROM scene WHERE video_id IN (SELECT id FROM target_videos)',
            'concepts': 'SELECT id FROM scene_concept WHERE segment_id IN (SELECT id FROM target_segments)',
        }.items():
            db.execute(f'CREATE TEMP TABLE target_{target}(id TEXT PRIMARY KEY)')
            db.execute(f'INSERT INTO target_{target} ' + query)

        def idle(rows, label):
            for row in rows:
                if row['state'] not in FINISHED:
                    raise HTTPException(409, f'{label} has a {row["state"]} job. Stop/cancel queued jobs and wait for running jobs to finish before deleting.')

        concepts = db.execute('SELECT * FROM concept_job WHERE segment_id IN (SELECT id FROM target_segments)').fetchall()
        idle(concepts, 'SRT to Prompt')
        for job in concepts:
            task = storyboard._concept_tasks.get(json.loads(job['payload']).get('text_batch_id') or job['id'])
            if task and not task.done():
                raise HTTPException(409, 'SRT to Prompt is still saving. Wait for it to finish before deleting.')
        request_where = '(? IS NOT NULL AND project_id=?) OR video_id IN (SELECT id FROM target_videos) OR scene_id IN (SELECT id FROM target_scenes)'
        args = (project_id, project_id)
        idle(db.execute('SELECT status AS state FROM request WHERE ' + request_where, args), 'Google Flow')
        media = aliases[str(desktop.STORE)]
        media_where = "(? IS NOT NULL AND json_extract(payload,'$.project_id')=?)" + ''.join(
            f" OR json_extract(payload,'$.{key}') IN (SELECT id FROM target_{target})"
            for key, target in [('video_id', 'videos'), ('scene_id', 'scenes'), ('document_id', 'documents'),
                                ('segment_id', 'segments'), ('concept_id', 'concepts')])
        idle(db.execute(f'SELECT state FROM {media}.jobs WHERE ' + media_where, args), 'Media')

        selected = set()
        resources = []
        for kind, (service, table_name) in registry.items():
            alias = aliases[str(service.store)]
            owned = db.execute(f'''SELECT resource_id FROM {alias}.resource_scope WHERE kind=? AND
                ((? IS NOT NULL AND project_id=?) OR video_id IN (SELECT id FROM target_videos))''', (kind, *args)).fetchall()
            selected.update((kind, r['resource_id']) for r in owned)
            for row in db.execute(f'SELECT * FROM {alias}.{table_name}').fetchall():
                owner = db.execute(f'SELECT sources FROM {alias}.resource_scope WHERE kind=? AND resource_id=?', (kind, row['id'])).fetchone()
                refs = {(r['kind'], str(r['id'])) for r in json.loads(owner['sources'])} if owner else set()
                # Include actual foreign IDs even for legacy/unassigned records.
                if kind == 'whisperx':
                    local = db.execute(f'SELECT 1 FROM {alias}.wx_sources WHERE id=?', (row['source_id'],)).fetchone()
                    refs.add(('audio' if local else 'elevenlabs', row['source_id']))
                elif kind == 'srt':
                    refs.add(('json', row['source_id']))
                elif kind == 'assembly':
                    plan = json.loads(row['plan'])
                    refs.update(('asset', aid) for aid in [plan['audio_id'], plan['srt_id'], *plan.get('image_ids', []), *plan.get('video_ids', [])])
                resources.append((kind, service, table_name, alias, row, refs))
        for kind, service, table_name, alias, row, refs in resources:
            key = (kind, row['id'])
            if key not in selected:
                if refs & selected:
                    raise HTTPException(409, 'A source is still used outside this project/video. Remove or reassign that dependent history before deleting.')
                continue
            if 'state' in row.keys():
                idle([row], kind.capitalize())
            active = getattr(service, 'active_id', None) or getattr(service, 'active', None)
            if isinstance(active, dict):
                active = active.get('job_id')
            if active == row['id'] or row['id'] in getattr(service, 'merging', set()):
                raise HTTPException(409, f'{kind.capitalize()} is still processing. Wait for it to finish before deleting.')
            if kind == 'elevenlabs':
                idle(db.execute(f'SELECT state FROM {alias}.eleven_chunks WHERE job_id=?', (row['id'],)), 'Narration')
        for row in db.execute('SELECT kind,source_id FROM document_source WHERE document_id NOT IN (SELECT id FROM target_documents)'):
            if (row['kind'], row['source_id']) in selected:
                raise HTTPException(409, 'A saved script in another video still uses this source. Remove that dependent script before deleting.')

        from agent.services import workspace_delete_files as files
        paths = files.collect(db, aliases, resources, selected, project_id, video_id, media_where, args)
        # No mutation occurs until every scope and active-job check has passed.
        moved = files.stage(paths, token)
        for kind, resource_id in selected:
            service, table_name = registry[kind]
            alias = aliases[str(service.store)]
            if kind == 'elevenlabs':
                db.execute(f'DELETE FROM {alias}.eleven_chunks WHERE job_id=?', (resource_id,))
            elif kind == 'srt':
                db.execute(f'DELETE FROM {alias}.srt_quality WHERE job_id=?', (resource_id,))
            db.execute(f'DELETE FROM {alias}.{table_name} WHERE id=?', (resource_id,))
            for auxiliary in ('resource_scope', 'job_settings'):
                db.execute(f'DELETE FROM {alias}.{auxiliary} WHERE kind=? AND resource_id=?', (kind, resource_id))
            if db.execute(f"SELECT 1 FROM {alias}.sqlite_master WHERE name='output_locations'").fetchone():
                db.execute(f'DELETE FROM {alias}.output_locations WHERE kind=? AND resource_id=?', (kind, resource_id))
        db.execute(f'DELETE FROM {media}.jobs WHERE ' + media_where, args)
        db.execute('DELETE FROM request WHERE ' + request_where, args)
        db.execute(f'DELETE FROM {"video" if video_id else "project"} WHERE id=?', (rid,))
        db.execute('INSERT INTO workspace_deletion(id) VALUES(?)', (token,))
        db.commit()
    except BaseException:
        db.rollback()
        if moved:
            files.restore(moved)
            files.journal_path(token).unlink(missing_ok=True)
        raise
    finally:
        db.close()
    pending = files.purge(moved)
    if not pending:
        files.journal_path(token).unlink(missing_ok=True)
        with sqlite3.connect(schema.DB_PATH) as cleanup:
            cleanup.execute('DELETE FROM workspace_deletion WHERE id=?', (token,))
    return {'ok': True, 'cleanup_pending': pending}
