"""Browsable project/video copies. Original job files and database paths stay intact."""
import asyncio
import csv
import hashlib
import io
import json
import logging
import re
import shutil
import uuid
from pathlib import Path

from agent.config import OUTPUT_DIR
from agent.db.schema import get_db

ROOT = OUTPUT_DIR / 'projects'
FOLDERS = ('elevenlabs', 'whisperx', 'srt', 'audio', 'text_prompts', 'scene_board', 'prompts/image', 'prompts/video', 'images', 'videos', 'exports')
_lock = asyncio.Lock()
log = logging.getLogger(__name__)


def child(parent, title, identity):
    """Names stay stable after a title edit; the identity suffix prevents collisions."""
    parent = Path(parent)
    parent.mkdir(parents=True, exist_ok=True)
    suffix = '--' + hashlib.sha256(str(identity).encode()).hexdigest()[:16]
    matches = list(parent.glob('*' + suffix))
    if len(matches) > 1:
        raise ValueError('Duplicate workspace folders: ' + str(parent))
    label = re.sub(r'[^\w -]', '_', title or 'Untitled', flags=re.UNICODE).strip(' .')[:32] or 'Untitled'
    folder = matches[0] if matches else parent / (label + suffix)
    if folder.is_symlink() or folder.resolve().parent != parent.resolve():
        raise ValueError('Workspace folder must be a local directory: ' + str(folder))
    folder.mkdir(exist_ok=True)
    return folder


def destination(root, relative):
    target = root / relative
    if not target.resolve().is_relative_to(root.resolve()) or any(p.is_symlink() for p in [target, *target.parents] if p != root.parent):
        raise ValueError('Unsafe workspace destination: ' + str(target))
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


def write(root, relative, data):
    target = destination(root, relative)
    raw = data.encode('utf-8') if isinstance(data, str) else data
    if target.is_file() and target.read_bytes() == raw:
        return
    temporary = target.with_name(target.name + '.' + uuid.uuid4().hex + '.part')
    try:
        temporary.write_bytes(raw)
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)


def copy(root, relative, source, allowed):
    source = Path(source)
    from agent.services.output_paths import allowed as permitted
    if source.is_symlink() or not permitted(source, allowed) or not source.is_file():
        raise ValueError('Saved source is missing or outside its storage directory: ' + str(source))
    target = destination(root, relative)
    if target.resolve() == source.resolve():
        return
    stat = source.stat()
    if not stat.st_size:
        raise ValueError('Saved source is empty: ' + str(source))
    if target.is_file() and (target.stat().st_size, target.stat().st_mtime_ns) == (stat.st_size, stat.st_mtime_ns):
        return
    temporary = target.with_name(target.name + '.' + uuid.uuid4().hex + '.part')
    try:
        shutil.copy2(source, temporary)
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)


async def folders(project_id, video_id=None):
    from fastapi import HTTPException
    db = await get_db()
    project = await (await db.execute("SELECT id,name FROM project WHERE id=? AND status!='DELETED'", (project_id,))).fetchone()
    if not project:
        raise HTTPException(404, 'Project not found.')
    video = None
    if video_id:
        video = await (await db.execute('SELECT id,title FROM video WHERE id=? AND project_id=?', (video_id, project_id))).fetchone()
        if not video:
            raise HTTPException(409, 'Video does not belong to this project.')
    project = dict(project)
    video = dict(video) if video else None
    def make():
        parent = child(ROOT, project['name'], project['id'])
        write(parent, 'project.json', json.dumps(project, ensure_ascii=False, indent=2))
        result = {'project_directory': str(parent), 'root_directory': str(ROOT)}
        if video:
            folder = child(parent, video['title'], video['id'])
            for name in FOLDERS:
                destination(folder, name + '/placeholder').parent.mkdir(exist_ok=True)
            write(folder, 'video.json', json.dumps({**video, 'project_id': project_id}, ensure_ascii=False, indent=2))
            result.update(directory=str(folder), folders={name: str(folder / name) for name in FOLDERS})
        return result
    return await asyncio.to_thread(make)


def owned_files(project_id, video_id):
    """Query exact ownership without history limits; never infer from active UI."""
    from agent.services import workflow_scope as scope
    result, errors = [], []
    for kind, (service, table) in scope.providers().items():
        with service.db() as db:
            rows = db.execute(f'''SELECT t.* FROM {table} t JOIN resource_scope s
                ON s.resource_id=t.id AND s.kind=? WHERE s.project_id=? AND s.video_id=?''',
                (kind, project_id, video_id)).fetchall()
        for row in rows:
            row = dict(row)
            rid = row['id']
            if not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}', rid):
                errors.append('Invalid resource ID: ' + rid)
                continue
            if row.get('state') in {'QUEUED', 'RUNNING', 'SUBMITTING', 'DOWNLOADING', 'CANCELLING'}:
                continue
            category = {'json': 'whisperx/imports', 'asset': 'imports', 'assembly': 'exports'}.get(kind, kind)
            if kind in {'elevenlabs', 'whisperx', 'srt'}:
                result.append((f'{category}/{rid}/job.json', json.dumps(row, ensure_ascii=False, indent=2), None, kind, rid))
                if kind == 'elevenlabs':
                    result.append((f'{category}/{rid}/source.txt', row['text'], None, kind, rid))
                from agent.services.output_paths import job_directory
                directory = job_directory(service, kind, rid)
                if directory.is_dir():
                    # Only durable stage outputs, not renderer caches or partial files.
                    for path in directory.iterdir():
                        if path.is_file() and path.suffix.lower() in {'.mp3', '.wav', '.m4a', '.json', '.srt', '.txt', '.log'}:
                            result.append((f'{category}/{rid}/{path.name}', path, service.output, kind, rid))
            elif kind == 'audio':
                result.append((f'audio/{rid}{Path(row["filename"]).suffix}', service.resolve_source(rid)[1], service.output, kind, rid))
            elif kind == 'json':
                result.append((f'whisperx/imports/{rid}.json', service.source_path(rid), service.output, kind, rid))
            elif kind == 'asset':
                category = {'srt': 'srt', 'audio': 'audio', 'image': 'images', 'video': 'videos'}.get(row['kind'], 'exports')
                path = service.path(row)
                result.append((f'{category}/imports/{rid}{path.suffix}', path, service.output, kind, rid))
            elif kind == 'assembly' and row['state'] == 'COMPLETED':
                path = service.result_path(rid)
                # New renders already live in exports/<job>/video.mp4. Avoid
                # copying large MP4s a second time during every workspace sync.
                relative = f'exports/{rid}/video.mp4' if path.parent.parent.name == 'exports' else f'exports/{rid}.mp4'
                result.append((relative, path, service.output, kind, rid))
    return result, errors


def stamp(milliseconds):
    seconds, ms = divmod(milliseconds, 1000)
    minutes, second = divmod(seconds, 60)
    hour, minute = divmod(minutes, 60)
    return f'{hour:02d}:{minute:02d}:{second:02d},{ms:03d}'


def save_snapshot(folder, data, source, files, errors):
    from agent.api import desktop, storyboard
    from agent.services.prompt_batch import ARCHIVE_DIR
    folder = Path(folder)
    manifest_path = folder / 'files.json'
    try:
        previous = json.loads(manifest_path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        previous = {}
    current, records = set(), []
    def save_copy(relative, path, allowed, kind, rid):
        try:
            copy(folder, relative, path, allowed)
            records.append({'file': relative, 'source': str(path), 'kind': kind, 'id': rid})
            return True
        except (OSError, ValueError) as exc:
            errors.append(str(exc))
            return False
    for relative, path, allowed, kind, rid in files:
        if allowed is None:
            write(folder, relative, path)
            records.append({'file': relative, 'kind': kind, 'id': rid})
        else:
            save_copy(relative, path, allowed, kind, rid)
    doc = data.get('document')
    if doc:
        write(folder, 'srt/script.txt', doc['script_text'])
        write(folder, 'prompts/template.txt', doc.get('prompt_template', ''))
        if source:
            extension = 'srt' if '-->' in source['content'] else 'json'
            write(folder, 'srt/source.' + extension, source['content'])
            current.add('srt/source.' + extension)
        if doc.get('audio_path'):
            path = Path(doc['audio_path'])
            save_copy('audio/narration' + path.suffix.lower(), path, storyboard.AUDIO_DIR, 'document', doc['id'])
    subtitles, mapping = [], []
    for scene in data['segments']:
        ordinal = f"{scene['ordinal']:03d}"
        subtitles.append(f"{scene['ordinal']}\n{stamp(scene['start_ms'])} --> {stamp(scene['end_ms'])}\n{scene['text']}\n")
        mapped = {'row': ordinal, 'segment_id': scene['id'], 'start_ms': scene['start_ms'], 'end_ms': scene['end_ms'], 'srt_text': scene['text']}
        for kind in ('image', 'video'):
            prompt = (scene.get('active_concept') or {}).get(kind + '_prompt', '')
            if scene.get('ready') and prompt.strip():
                relative = f'prompts/{kind}/{ordinal}.txt'
                write(folder, relative, prompt)
                current.add(relative)
            job = next((j for j in scene['media_jobs'] if j['kind'] == kind and j['current'] and j['state'] == 'COMPLETED' and j['files']), None)
            names = []
            if job:
                for i, filename in enumerate(job['files']):
                    path = Path(filename)
                    if path.suffix.lower() not in ({'.png', '.jpg', '.jpeg', '.webp', '.avif'} if kind == 'image' else {'.mp4', '.webm', '.mov'}):
                        errors.append('Unsupported media file: ' + str(path))
                        continue
                    name = ordinal + (f'_{i+1:02d}' if i else '') + path.suffix.lower()
                    relative = f'{kind}s/{name}'
                    if save_copy(relative, path, desktop.ROOT, kind, job['id']):
                        current.add(relative)
                        names.append(relative)
            mapped[kind + '_files'] = ';'.join(names)
            mapped[kind + '_job_id'] = job['id'] if job else ''
        mapping.append(mapped)
    write(folder, 'srt/scenes.srt', '\n'.join(subtitles))
    output = io.StringIO(newline='')
    writer = csv.DictWriter(output, fieldnames=['row', 'segment_id', 'start_ms', 'end_ms', 'srt_text', 'image_files', 'image_job_id', 'video_files', 'video_job_id'])
    writer.writeheader()
    writer.writerows(mapping)
    write(folder, 'scenes.csv', '\ufeff' + output.getvalue())
    # ZIP history is isolated by run; only committed current prompts appear above.
    for run in data.get('prompt_outputs', []):
        directory = Path(run['directory'])
        if not (directory.resolve().is_relative_to(ARCHIVE_DIR.resolve()) or directory.resolve().is_relative_to(folder.resolve())):
            continue
        if directory.resolve().is_relative_to(folder.resolve()):
            continue  # Already stored here; do not duplicate ZIP/TXT history.
        for path in directory.rglob('*'):
            if path.is_file() and path.suffix in {'.txt', '.zip'}:
                relative = 'prompts/runs/' + directory.name + '/' + path.relative_to(directory).as_posix()
                save_copy(relative, path, ARCHIVE_DIR, 'prompt_run', directory.name)
    # Remove only our previous current-view copies, never originals/history/user files.
    for name in previous.get('current', []):
        if name not in current and re.fullmatch(r'(?:prompts/(?:image|video)/\d+\.txt|(?:images|videos)/\d+(?:_\d+)?\.[a-z0-9]+|srt/source\.(?:srt|json|txt))', name):
            destination(folder, name).unlink(missing_ok=True)
    write(folder, 'files.json', json.dumps({'video_id': data['video']['id'], 'project_id': data['video']['project_id'], 'current': sorted(current), 'files': records, 'warnings': errors}, ensure_ascii=False, indent=2))
    write(folder, 'README.txt', 'Files for this video only. Updated automatically while the backend runs.\n'
          'elevenlabs/: narration chunks and merged audio, separated by job.\n'
          'whisperx/: transcripts, splits and worker logs, separated by job.\n'
          'srt/: original sources, SRT job versions and current scenes.srt.\n'
          'prompts/: put prompt_instructions_image.txt and prompt_instructions_video_4s.txt,\n'
          'prompt_instructions_video_6s.txt, prompt_instructions_video_8s.txt, prompt_instructions_video_10s.txt here.\n'
          'SRT to Prompt auto-loads these files; manual uploads/edits take priority. UTF-8 TXT, max 97000 characters.\n'
          'prompts/image/ and prompts/video/: current numbered scene prompts.\n'
          'prompts/runs/: downloaded TXT/ZIP history.\n'
          'images/ and videos/: current numbered scene media (001, 002...).\n'
          'audio/: imported narration. exports/: assembled videos.\n'
          'scenes.csv: row, text, exact segment ID and matching media job IDs.\n'
          'files.json: source paths and copy warnings. Original job files stay intact.\n'
          'Folders keep their initial names after title changes; video.json has the current title.\n')
    return {'files': len(records), 'warnings': errors}


async def sync_video(project_id, video_id):
    from agent.api import storyboard
    async with _lock:
        paths = await folders(project_id, video_id)
        files, errors = await asyncio.to_thread(owned_files, project_id, video_id)
        # Serialize snapshot/copies with scene edits so a late snapshot cannot
        # replace the current numbered media after the scene changes.
        async with storyboard._db_lock:
            data = await storyboard.read_document(video_id)
            source = None
            if data['document']:
                rows = await storyboard.query('SELECT * FROM document_source WHERE document_id=?', (data['document']['id'],))
                source = rows[0] if rows else None
            result = await asyncio.to_thread(save_snapshot, paths['directory'], data, source, files, errors)
        return {**paths, **result}


async def run():
    last_warnings = {}
    while True:
        try:
            db = await get_db()
            rows = await (await db.execute("SELECT v.id,v.project_id FROM video v JOIN project p ON p.id=v.project_id WHERE p.status!='DELETED'")).fetchall()
            for row in rows:
                try:
                    result = await sync_video(row['project_id'], row['id'])
                    if result['warnings'] and result['warnings'] != last_warnings.get(row['id']):
                        log.warning('Video folder %s: %s', row['id'], '; '.join(result['warnings']))
                    last_warnings[row['id']] = result['warnings']
                except Exception:
                    log.exception('Could not organize video files: %s', row['id'])
        except Exception:
            log.exception('Project file organizer failed')
        await asyncio.sleep(15)
