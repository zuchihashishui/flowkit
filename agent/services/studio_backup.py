"""Portable Studio data snapshots and offline restore into a new directory.

No browser sessions, credentials, Python environments or application code are
exported. SQLite's backup API includes committed WAL data. Restore never writes
to the running Studio's directory and checks every entry before extracting it.
"""
from __future__ import annotations

import argparse
import asyncio
from contextlib import ExitStack, closing
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import stat
import tempfile
import threading
import time
import uuid
import zipfile

from agent.config import BASE_DIR

DATABASES = ('flow_agent.db', 'desktop_jobs.db', 'elevenlabs_jobs.db',
             'whisperx_jobs.db', 'srt_jobs.db', 'assembly_jobs.db', 'chatgpt_jobs.db')
ACTIVE_TABLES = {'request': 'status', 'concept_job': 'state', 'jobs': 'state',
                 'eleven_jobs': 'state', 'eleven_chunks': 'state', 'wx_jobs': 'state',
                 'srt_jobs': 'state', 'assembly_jobs': 'state', 'requests': 'state',
                 'chat_queue': 'state'}
ACTIVE_STATES = ('PENDING', 'QUEUED', 'RUNNING', 'PROCESSING', 'SUBMITTING', 'DOWNLOADING')
SCHEMA_VERSION = 1
MAX_ENTRIES = 250_000
MAX_UNCOMPRESSED = 2 * 1024**4  # 2 TiB; streaming extraction also checks free disk space.
_lock = threading.Lock()
_jobs: dict[str, dict] = {}


def is_backing_up():
    return _lock.locked() or any(job['state'] == 'RUNNING' for job in _jobs.values())


def _quote(name):
    return '"' + name.replace('"', '""') + '"'


def _digest(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _clean_config(value):
    # Config snapshots are intentionally not credential backups.
    secret = re.compile(r'(api.?key|token|secret|password|cookie|authorization|credential)', re.I)
    if isinstance(value, dict):
        return {k: _clean_config(v) for k, v in value.items() if not secret.search(k)}
    if isinstance(value, list):
        return [_clean_config(v) for v in value]
    return value


def _assert_idle(db, label):
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    for table, column in ACTIVE_TABLES.items():
        if table not in tables:
            continue
        columns = {r[1] for r in db.execute(f'PRAGMA table_info({_quote(table)})')}
        if column not in columns:
            continue
        count = db.execute(f'SELECT COUNT(*) FROM {_quote(table)} WHERE {_quote(column)} IN ({",".join("?" for _ in ACTIVE_STATES)})', ACTIVE_STATES).fetchone()[0]
        if count:
            raise ValueError(f'Finish or cancel queued and active work before backup: {label}/{table} has {count} pending job(s). Saved and review-required jobs are retained.')


def _safe_source(root, path):
    if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError('Backup does not follow symlinks or files outside the data directory.')
    return path


def create_archive(base=None, include_media=False, *, destination=None, job_id=None):
    """Synchronous snapshot; caller runs this in a thread or with Studio stopped."""
    root = Path(base or BASE_DIR).resolve()
    if not root.is_dir():
        raise ValueError('Studio data directory does not exist.')
    bid = job_id or str(uuid.uuid4())
    output = Path(destination) if destination else root / 'backups' / f'flowkit-backup-{bid}.zip'
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise ValueError('Backup destination already exists.')
    if not _lock.acquire(blocking=False):
        raise ValueError('Another Studio backup is running.')
    part = output.with_suffix('.zip.part')
    try:
        with tempfile.TemporaryDirectory(prefix='flowkit-backup-') as tmp, ExitStack() as stack:
            staging = Path(tmp)
            sources = []
            # Reserve writes to all existing stores before taking any snapshot.
            # There must be no queued/active work, so media cannot still be written.
            for name in DATABASES:
                path = root / name
                if not path.exists():
                    continue
                _safe_source(root, path)
                lock_db = sqlite3.connect(str(path), timeout=2)
                stack.callback(lock_db.close)
                lock_db.execute('BEGIN IMMEDIATE')
                _assert_idle(lock_db, name)
                sources.append((name, path))
            if not any(name == 'flow_agent.db' for name, _ in sources):
                raise ValueError('No Flowkit project database was found.')
            for name, path in sources:
                with closing(sqlite3.connect(str(path))) as source, closing(sqlite3.connect(staging / name)) as target:
                    source.backup(target)
                    if target.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                        raise ValueError('A database failed its integrity check: ' + name)
            for name in ('models.json', 'providers.json'):
                candidates = (root / 'config' / name, Path(__file__).parents[1] / name)
                source = next((p for p in candidates if p.is_file()), None)
                if source:
                    config = staging / 'config' / name
                    config.parent.mkdir(exist_ok=True)
                    config.write_text(json.dumps(_clean_config(json.loads(source.read_text(encoding='utf-8'))), ensure_ascii=False, indent=2), encoding='utf-8')
            entries = [(p.relative_to(staging).as_posix(), p) for p in staging.rglob('*') if p.is_file()]
            if include_media and (root / 'output').exists():
                _safe_source(root, root / 'output')
                for folder, dirs, files in os.walk(root / 'output', followlinks=False):
                    for child in dirs:
                        _safe_source(root, Path(folder) / child)
                    for name in files:
                        path = _safe_source(root, Path(folder) / name)
                        if path.suffix not in {'.part', '.tmp'}:
                            entries.append((path.relative_to(root).as_posix(), path))
            if len(entries) > MAX_ENTRIES:
                raise ValueError('Backup has too many files.')
            total = sum(p.stat().st_size for _, p in entries)
            if total > MAX_UNCOMPRESSED or shutil.disk_usage(output.parent).free < total + 64 * 1024**2:
                raise ValueError('Not enough free disk space for this backup.')
            manifest = {'format': 'flowkit-studio-backup', 'version': SCHEMA_VERSION,
                        'created': time.time(), 'source_root': str(root), 'include_media': bool(include_media),
                        'databases': [name for name, _ in sources], 'files': []}
            with zipfile.ZipFile(part, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as archive:
                for name, source in entries:
                    size = source.stat().st_size
                    digest = hashlib.sha256()
                    # Hash precisely the bytes archived, rather than re-reading a file that could change.
                    with source.open('rb') as src, archive.open(name, 'w', force_zip64=True) as dst:
                        while chunk := src.read(1024 * 1024):
                            digest.update(chunk)
                            dst.write(chunk)
                    if source.stat().st_size != size:
                        raise ValueError('A media file changed during backup. Try again when Studio is idle.')
                    manifest['files'].append({'path': name, 'bytes': size, 'sha256': digest.hexdigest()})
                archive.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
            part.replace(output)
            return {'id': bid, 'state': 'COMPLETED', 'filename': output.name,
                    'include_media': bool(include_media), 'bytes': output.stat().st_size,
                    'files': len(entries), 'created': manifest['created']}
    finally:
        part.unlink(missing_ok=True)
        _lock.release()


async def start_backup(include_media=False):
    if is_backing_up() or any(j['state'] == 'RUNNING' for j in _jobs.values()):
        raise ValueError('Another Studio backup is running.')
    bid = str(uuid.uuid4())
    _jobs[bid] = {'id': bid, 'state': 'RUNNING', 'filename': f'flowkit-backup-{bid}.zip',
                  'include_media': bool(include_media), 'created': time.time()}

    async def run():
        try:
            _jobs[bid] = await asyncio.to_thread(create_archive, include_media=include_media, job_id=bid)
        except Exception as error:
            _jobs[bid].update(state='FAILED', error=str(error)[:2000])

    # Retain the task until done; task errors are persisted into the status record.
    task = asyncio.create_task(run())
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return dict(_jobs[bid])


_tasks = set()


def list_backups():
    rows = {key: dict(value) for key, value in _jobs.items()}
    for path in (BASE_DIR / 'backups').glob('flowkit-backup-*.zip'):
        bid = path.name.removeprefix('flowkit-backup-').removesuffix('.zip')
        if re.fullmatch(r'[a-f0-9-]{36}', bid) and bid not in rows and not path.is_symlink():
            rows[bid] = {'id': bid, 'state': 'COMPLETED', 'filename': path.name,
                         'bytes': path.stat().st_size, 'created': path.stat().st_mtime}
    return sorted(rows.values(), key=lambda r: r['created'], reverse=True)


def backup_file(bid):
    if not re.fullmatch(r'[a-f0-9-]{36}', bid):
        raise ValueError('Invalid backup ID.')
    target = BASE_DIR / 'backups' / f'flowkit-backup-{bid}.zip'
    if target.is_symlink() or not target.is_file() or not target.resolve().is_relative_to(BASE_DIR.resolve()):
        raise FileNotFoundError('Backup is not available.')
    return target


def _entry_name(name):
    path = PurePosixPath(name)
    if (not name or '\\' in name or ':' in name or '\x00' in name or path.is_absolute()
            or any(p in {'..', '.'} for p in name.split('/')) or name.endswith('/')
            or str(path) != name):
        raise ValueError('Unsafe archive entry: ' + name[:200])
    reserved = re.compile(r'^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)', re.I)
    if any(part.endswith((' ', '.')) or reserved.match(part) for part in path.parts):
        raise ValueError('Archive entry is not portable to Windows: ' + name[:200])
    if name != 'manifest.json' and name not in DATABASES and not name.startswith(('output/', 'config/')):
        raise ValueError('Unexpected archive entry: ' + name[:200])
    return path


def _rebase(value, old_root, target, available, stats):
    if isinstance(value, dict):
        return {key: _rebase(item, old_root, target, available, stats) for key, item in value.items()}
    if isinstance(value, list):
        return [_rebase(item, old_root, target, available, stats) for item in value]
    if not isinstance(value, str):
        return value
    normalized = value.replace('\\', '/')
    prefix = old_root.replace('\\', '/').rstrip('/') + '/'
    if normalized.startswith(prefix):
        rel = normalized[len(prefix):]
        parts = PurePosixPath(rel).parts
        if '..' not in parts and parts and parts[0] == 'output':
            stats['rebased_paths'] += 1
            if rel not in available:
                stats['missing_media_paths'] += 1
            return str(target.joinpath(*parts))
    return value


def _rebase_database(path, old_root, target, available, stats):
    with closing(sqlite3.connect(path)) as db, db:
        db.execute('PRAGMA trusted_schema=OFF')
        if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise ValueError('Restored database failed its integrity check.')
        tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        for table in tables:
            columns = [row[1] for row in db.execute(f'PRAGMA table_info({_quote(table)})') if row[2].upper() == 'TEXT']
            if not columns:
                continue
            # All application tables have rowids. Unknown WITHOUT ROWID tables are rejected.
            for row in db.execute(f'SELECT rowid,{",".join(map(_quote, columns))} FROM {_quote(table)}').fetchall():
                updates = {}
                for column, raw in zip(columns, row[1:]):
                    if not isinstance(raw, str):
                        continue
                    structured = False
                    value = raw
                    if raw.lstrip().startswith(('[', '{')):
                        try:
                            value = json.loads(raw)
                            structured = True
                        except ValueError:
                            pass
                    replacement = _rebase(value, old_root, target, available, stats)
                    if replacement != value:
                        updates[column] = json.dumps(replacement, ensure_ascii=False) if structured else replacement
                if updates:
                    db.execute(f'UPDATE {_quote(table)} SET ' + ','.join(_quote(k)+'=?' for k in updates) + ' WHERE rowid=?', (*updates.values(), row[0]))


def restore_archive(archive_path, target):
    """Restore only to a NEW folder, verified first; never replace live data."""
    archive_path = Path(archive_path).resolve()
    target = Path(target).absolute()
    if target.exists() or target.is_symlink():
        raise ValueError('Restore destination must be a new directory. Existing data is never overwritten.')
    parent = target.parent.resolve(strict=True)
    target = parent / target.name
    stats = {'rebased_paths': 0, 'missing_media_paths': 0}
    with zipfile.ZipFile(archive_path) as archive:
        infos = archive.infolist()
        names = [i.filename for i in infos]
        if len(infos) > MAX_ENTRIES + 1 or len(names) != len(set(names)) or len(names) != len({n.casefold() for n in names}):
            raise ValueError('Duplicate or excessive archive entries.')
        for info in infos:
            _entry_name(info.filename)
            if info.is_dir() or stat.S_ISLNK(info.external_attr >> 16) or info.flag_bits & 1:
                raise ValueError('Links, directories and encrypted archive entries are unsupported.')
        if 'manifest.json' not in names or archive.getinfo('manifest.json').file_size > 64 * 1024**2:
            raise ValueError('Backup manifest is missing or too large.')
        manifest = json.loads(archive.read('manifest.json'))
        if manifest.get('format') != 'flowkit-studio-backup' or manifest.get('version') != SCHEMA_VERSION:
            raise ValueError('Unsupported Studio backup format.')
        files = manifest.get('files')
        if not isinstance(files, list) or not isinstance(manifest.get('source_root'), str) or not manifest['source_root']:
            raise ValueError('Invalid backup manifest.')
        expected = {}
        for entry in files:
            if not isinstance(entry, dict) or not isinstance(entry.get('path'), str):
                raise ValueError('Invalid manifest entry.')
            name = entry['path']
            _entry_name(name)
            if (name == 'manifest.json' or name in expected or not isinstance(entry.get('bytes'), int)
                    or entry['bytes'] < 0 or not re.fullmatch(r'[0-9a-f]{64}', str(entry.get('sha256', '')))):
                raise ValueError('Invalid manifest entry.')
            expected[name] = entry
        if set(expected) != set(names) - {'manifest.json'} or 'flow_agent.db' not in expected:
            raise ValueError('Archive contents do not match the manifest.')
        database_names = manifest.get('databases')
        if (not isinstance(database_names, list) or not all(isinstance(n, str) for n in database_names)
                or set(database_names) != set(expected) & set(DATABASES)):
            raise ValueError('Invalid database manifest.')
        total = sum(entry['bytes'] for entry in expected.values())
        if total > MAX_UNCOMPRESSED or shutil.disk_usage(parent).free < total + 64 * 1024**2:
            raise ValueError('Not enough free disk space to restore this backup.')
        for name, entry in expected.items():
            if archive.getinfo(name).file_size != entry['bytes']:
                raise ValueError('Archive file size does not match the manifest.')
        staging = Path(tempfile.mkdtemp(prefix='.flowkit-restore-', dir=parent))
        try:
            for name, entry in expected.items():
                destination = staging.joinpath(*PurePosixPath(name).parts)
                destination.parent.mkdir(parents=True, exist_ok=True)
                digest = hashlib.sha256()
                written = 0
                with archive.open(name) as source, destination.open('xb') as dest:
                    while data := source.read(1024 * 1024):
                        written += len(data)
                        if written > entry['bytes']:
                            raise ValueError('Archive entry exceeds its declared size.')
                        digest.update(data)
                        dest.write(data)
                if written != entry['bytes'] or digest.hexdigest() != entry['sha256']:
                    raise ValueError('Backup integrity check failed: ' + name)
            for name in database_names:
                _rebase_database(staging / name, manifest['source_root'], target, expected, stats)
            # Voice template metadata and render plans can also contain absolute paths.
            for path in (staging / 'output').rglob('*.json') if (staging / 'output').exists() else ():
                if path.stat().st_size > 32 * 1024**2:
                    continue
                try:
                    old = json.loads(path.read_text(encoding='utf-8'))
                except (ValueError, UnicodeDecodeError):
                    continue
                new = _rebase(old, manifest['source_root'], target, expected, stats)
                if new != old:
                    path.write_text(json.dumps(new, ensure_ascii=False), encoding='utf-8')
            report = {'directory': str(target), 'launch_env': {'FLOW_AGENT_DIR': str(target)},
                      'include_media': bool(manifest.get('include_media')), 'files': len(expected),
                      **stats, 'message': 'Restore completed in a separate data directory. Existing Studio data was not changed.'}
            (staging / 'restore-report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
            # Reserve the name exclusively; no rename-over-existing race on Unix.
            target.mkdir()
            try:
                for child in staging.iterdir():
                    child.replace(target / child.name)
            except BaseException:
                shutil.rmtree(target, ignore_errors=True)
                raise
            return report
        finally:
            shutil.rmtree(staging, ignore_errors=True)


async def duplicate_project(project_id, name):
    """Copy reusable configuration locally; no remote service calls or content."""
    from agent.db.schema import get_db, _db_lock
    from agent.services import project_settings
    name = name.strip()
    if not name or len(name) > 200:
        raise ValueError('Enter a project name between 1 and 200 characters.')
    async with _db_lock:
        db = await get_db()
        source = await (await db.execute("SELECT * FROM project WHERE id=? AND status!='DELETED'", (project_id,))).fetchone()
        if not source:
            raise ValueError('Project not found.')
        settings = await project_settings.get(project_id)
        settings.pop('revision', None)
        shared_instructions = settings.pop('instruction_files', None)
        url = settings['google_flow_url']
        effective_remote = project_settings.flow_project(url, project_id)
        if '/project/' not in url:
            # Old projects store the remote Flow ID as their local primary key.
            try:
                uuid.UUID(effective_remote)
            except (ValueError, TypeError):
                raise ValueError('Set a Google Flow project URL before duplicating this project.')
            settings['google_flow_url'] = 'https://flow.google.com/project/' + effective_remote
        new_id = str(uuid.uuid4())
        fields = ('description', 'language', 'user_paygate_tier', 'narrator_voice',
                  'narrator_ref_audio', 'material', 'allow_music', 'allow_voice')
        try:
            await db.execute('INSERT INTO project(id,name,' + ','.join(fields) + ') VALUES(' + ','.join('?' for _ in range(len(fields)+2)) + ')', (new_id, name, *(source[k] for k in fields)))
            await db.execute('INSERT INTO project_settings(project_id,value,revision) VALUES(?,?,1)', (new_id, json.dumps(settings)))
            if shared_instructions and shared_instructions['configured']:
                from agent.services import project_instructions
                fresh = await asyncio.to_thread(project_instructions.read, new_id, name)
                await asyncio.to_thread(project_instructions.write, new_id, name, project_instructions.InstructionUpdate(
                    revision=fresh['revision'], templates={k: v['text'] for k, v in shared_instructions['templates'].items()}))
            await db.commit()
        except BaseException:
            await db.rollback()
            raise
        return {'project': dict(await (await db.execute('SELECT * FROM project WHERE id=?', (new_id,))).fetchone()),
                'copied': 'configuration_only', 'google_flow_url': settings['google_flow_url'],
                'message': 'Project configuration copied. Videos and jobs were not copied. The Google Flow destination is shared until you change its URL.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    export = commands.add_parser('backup', help='Run with Studio stopped or idle.')
    export.add_argument('--data-dir', type=Path, default=BASE_DIR)
    export.add_argument('--output', type=Path, required=True)
    export.add_argument('--include-media', action='store_true')
    restore = commands.add_parser('restore', help='Restore into a NEW data directory.')
    restore.add_argument('archive', type=Path)
    restore.add_argument('target', type=Path)
    args = parser.parse_args()
    try:
        result = (restore_archive(args.archive, args.target) if args.command == 'restore'
                  else create_archive(args.data_dir, args.include_media, destination=args.output))
    except (ValueError, OSError, sqlite3.Error, zipfile.BadZipFile) as error:
        parser.exit(1, json.dumps({'error': str(error)}) + '\n')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
