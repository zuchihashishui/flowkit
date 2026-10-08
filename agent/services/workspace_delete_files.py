"""Stage only owned, managed output paths; restore them if database deletion fails."""
import hashlib
import json
import os
import re
import shutil
from pathlib import Path

from fastapi import HTTPException


def collect(db, aliases, resources, selected, project_id, video_id, media_where, args):
    from agent.api import desktop, storyboard
    from agent.services import video_files, prompt_batch
    candidates, keep = set(), set()

    def add(path, root, owned):
        if not path:
            return
        path, root = Path(path), Path(root).resolve()
        if not path.exists() and not path.is_symlink():
            return
        if not owned:
            keep.add(path.resolve())
            return
        if path.is_symlink() or any(p.is_symlink() for p in path.parents):
            raise HTTPException(409, 'An output path is a symbolic link. Resolve it before deleting: ' + str(path))
        path = path.resolve()
        if path == root or not path.is_relative_to(root):
            raise HTTPException(409, 'An output path is outside its managed folder: ' + str(path))
        (candidates if owned else keep).add(path)

    def saved(path, root, owned):
        if not path:
            return
        path = Path(path)
        if owned and path.exists() and path.resolve().is_relative_to(video_files.ROOT.resolve()):
            if not any(path.resolve().is_relative_to(folder.resolve()) for folder in workspace_dirs):
                raise HTTPException(409, 'An output path belongs to a different project/video: ' + str(path))
        # Scoped files and legacy files are both managed, in distinct roots.
        add(path, video_files.ROOT if path.resolve().is_relative_to(video_files.ROOT.resolve()) else root, owned)

    def identity(value):
        if not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}', str(value)):
            raise HTTPException(409, 'Invalid saved output identifier.')
        return str(value)

    def folders(parent, value):
        suffix = '--' + hashlib.sha256(str(value).encode()).hexdigest()[:16]
        return list(Path(parent).glob('*' + suffix))

    pid = project_id or db.execute('SELECT project_id FROM video WHERE id=?', (video_id,)).fetchone()[0]
    workspace_dirs = []
    for parent in folders(video_files.ROOT, pid):
        for path in folders(parent, video_id) if video_id else [parent]:
            workspace_dirs.append(path)
            add(path, video_files.ROOT, True)
    if project_id:
        from agent.config import BASE_DIR, OUTPUT_DIR
        for root in {Path(OUTPUT_DIR), Path(BASE_DIR) / 'output'}:
            for meta in root.glob('*/meta.json'):
                if meta.is_symlink():
                    continue
                try:
                    owner = json.loads(meta.read_text(encoding='utf-8'))
                except (OSError, ValueError):
                    continue
                if owner.get('project_id') == project_id:
                    add(meta.parent, root, True)
    for kind, service, table, alias, row, refs in resources:
        owned = (kind, row['id']) in selected
        rid = identity(row['id'])
        if kind == 'audio':
            legacy = service.output / '_imports' / row['filename']
        elif kind == 'json':
            legacy = service.output / (rid + '.json')
        elif kind == 'asset':
            legacy = service.output / 'assets' / row['filename']
        else:
            legacy = service.output / rid
        saved(legacy, service.output, owned)
        if db.execute(f"SELECT 1 FROM {alias}.sqlite_master WHERE name='output_locations'").fetchone():
            location = db.execute(f'SELECT path FROM {alias}.output_locations WHERE kind=? AND resource_id=?', (kind, rid)).fetchone()
            if location:
                saved(location['path'], service.output, owned)
    for row in db.execute('SELECT audio_path,id IN (SELECT id FROM target_documents) AS owned FROM script_document'):
        saved(row['audio_path'], storyboard.AUDIO_DIR, bool(row['owned']))
    media = aliases[str(desktop.STORE)]
    for row in db.execute(f'SELECT *,({media_where}) AS owned FROM {media}.jobs', args):
        owned = bool(row['owned'])
        saved(desktop.ROOT / identity(row['id']), desktop.ROOT, owned)
        for path in json.loads(row['files']):
            saved(path, desktop.ROOT, owned)
    for row in db.execute('SELECT payload,segment_id IN (SELECT id FROM target_segments) AS owned FROM concept_job'):
        payload = json.loads(row['payload'])
        run = payload.get('text_output_id') or payload.get('text_session_id')
        if run:
            saved(prompt_batch.ARCHIVE_DIR / identity(run), prompt_batch.ARCHIVE_DIR, bool(row['owned']))
    for path in candidates:
        if any(p == path or p.is_relative_to(path) or path.is_relative_to(p) for p in keep):
            raise HTTPException(409, 'A saved file is also used outside this project/video. Resolve that shared source before deleting: ' + str(path))
    # Parent folder deletion already covers its children.
    return sorted((p for p in candidates if not any(parent in candidates for parent in p.parents)), key=str)


def journal_path(token):
    from agent.db import schema
    return Path(schema.DB_PATH).parent / 'workspace_deletions' / (token + '.json')


def stage(paths, token):
    journal = journal_path(token)
    journal.parent.mkdir(parents=True, exist_ok=True)
    planned = [(path, path.with_name(f'.flowkit-delete-{token}-{i}')) for i, path in enumerate(paths)]
    # Preserve the original names even if the process stops during renaming.
    temporary = journal.with_suffix('.part')
    with temporary.open('x', encoding='utf-8') as out:
        json.dump([[str(a), str(b)] for a, b in planned], out)
        out.flush()
        os.fsync(out.fileno())
    temporary.replace(journal)
    moved = []
    try:
        for path, target in planned:
            path.rename(target)
            moved.append((path, target))
        return moved
    except OSError as error:
        restore(moved)
        journal.unlink(missing_ok=True)
        raise HTTPException(409, 'Could not remove an output file. Close any application using it and retry. ' + str(error)) from error


def restore(moved):
    for original, staged in reversed(moved):
        if staged.exists():
            if original.exists():
                raise RuntimeError('Cannot restore deleted output over an existing path: ' + str(original))
            staged.rename(original)


def purge(moved):
    pending = []
    for original, staged in moved:
        try:
            if staged.is_dir():
                shutil.rmtree(staged)
            else:
                staged.unlink(missing_ok=True)
        except OSError:
            pending.append(str(staged))
    return pending


def recover():
    """Finish committed cleanup, or restore an interrupted uncommitted deletion."""
    import sqlite3
    from agent.db import schema
    from agent.api import desktop, storyboard
    from agent.config import OUTPUT_DIR, BASE_DIR
    from agent.services import workflow_scope, video_files, prompt_batch
    roots = [Path(OUTPUT_DIR), Path(BASE_DIR)/'output', video_files.ROOT, desktop.ROOT,
             storyboard.AUDIO_DIR, prompt_batch.ARCHIVE_DIR,
             *(s.output for s, _ in workflow_scope.providers().values())]
    folder = Path(schema.DB_PATH).parent / 'workspace_deletions'
    if not folder.exists():
        return
    with sqlite3.connect(schema.DB_PATH) as db:
        for journal in folder.glob('*.json'):
            token = journal.stem
            if not re.fullmatch(r'[a-f0-9]{32}', token) or journal.is_symlink():
                raise RuntimeError('Invalid workspace deletion journal: ' + str(journal))
            paths = [(Path(a), Path(b)) for a,b in json.loads(journal.read_text(encoding='utf-8'))]
            for i, (original, staged) in enumerate(paths):
                if (not original.is_absolute() or staged.parent != original.parent or
                        staged.name != f'.flowkit-delete-{token}-{i}' or original.is_symlink() or staged.is_symlink() or
                        any(p.is_symlink() for p in original.parents) or
                        not any(original.resolve() != root.resolve() and original.resolve().is_relative_to(root.resolve()) for root in roots)):
                    raise RuntimeError('Invalid workspace deletion path: ' + str(journal))
            committed = db.execute('SELECT 1 FROM workspace_deletion WHERE id=?', (token,)).fetchone()
            if committed:
                if purge(paths):
                    continue  # A locked file will be retried on the next start.
            else:
                restore(paths)
            journal.unlink()
            db.execute('DELETE FROM workspace_deletion WHERE id=?', (token,))
