"""Numbered scene-image copies; immutable per-job originals remain untouched."""
<<<<<<< HEAD
from agent.services import output_paths

=======
>>>>>>> ae804f6f6558557cae163f49f007427697ddd2af
import asyncio
import json
import re
import shutil
import uuid
from pathlib import Path

from agent.config import OUTPUT_DIR


def image_folder(video_id):
<<<<<<< HEAD
    from agent.services.output_paths import video_directory
    return video_directory({'video_id': str(uuid.UUID(video_id))}) / 'images'
=======
    return OUTPUT_DIR / 'scene_images' / str(uuid.UUID(video_id))
>>>>>>> ae804f6f6558557cae163f49f007427697ddd2af


def copy_image(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + '.' + uuid.uuid4().hex + '.part')
    try:
        shutil.copy2(source, temporary)
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)


async def collect_images(video_id, segment_ids=None):
    from agent.api import storyboard, desktop
    # Serialize copies with source edits and other scene-image completions.
    # Re-read the latest completed job inside this lock so an older job finishing
    # late cannot overwrite the result of a newer completed generation.
    async with storyboard._db_lock:
        data = await storyboard.read_document(video_id)
        folder = image_folder(video_id)
        index_path = folder / '.scene-images.json'
        try:
            index = json.loads(index_path.read_text(encoding='utf-8'))
            if not isinstance(index, dict):
                index = {}
        except (OSError, ValueError):
            index = {}
        copied, skipped, recovered = [], [], []
        for scene in data['segments']:
            if segment_ids is not None and scene['id'] not in segment_ids:
                continue
            job = next((j for j in scene['media_jobs'] if j['kind'] == 'image'
                        and j['current'] and j['state'] == 'COMPLETED' and j['files']), None)
            if not job:
                continue
            sources = []
            for filename in job['files']:
                source = Path(filename).resolve()
<<<<<<< HEAD
                if (not output_paths.allowed(source, desktop.ROOT) or not source.is_file()
=======
                if (not source.is_relative_to(desktop.ROOT.resolve()) or not source.is_file()
>>>>>>> ae804f6f6558557cae163f49f007427697ddd2af
                        or source.stat().st_size == 0 or source.suffix.lower() not in {'.png','.jpg','.jpeg','.webp','.avif'}):
                    skipped.append(f"Scene {scene['ordinal']:03d}: saved image is missing or invalid.")
                    break
                sources.append(source)
            if len(sources) != len(job['files']):
                continue
            names = []
            for position, source in enumerate(sources):
                suffix = '' if position == 0 else f'_{position + 1:02d}'
                target = folder / f"{scene['ordinal']:03d}{suffix}{source.suffix.lower()}"
                await asyncio.to_thread(copy_image, source, target)
                copied.append(str(target))
                names.append(target.name)
            key = str(scene['ordinal'])
            old = index.get(key, {})
            # Only remove copies recorded by us for this scene (e.g. a prior
            # JPG when regeneration returned PNG). Originals stay in job folders.
            for name in old.get('files', []) if isinstance(old, dict) else []:
                if isinstance(name, str) and name not in names and re.fullmatch(rf"{scene['ordinal']:03d}(?:_\d+)?\.(?:png|jpg|jpeg|webp|avif)", name):
                    (folder / name).unlink(missing_ok=True)
            index[key] = {'job_id':job['id'], 'files':names}
            if (job.get('error') or '').startswith('Image saved; scene folder copy failed:'):
                recovered.append(job['id'])
        if copied:
            temporary = index_path.with_suffix('.json.part')
            try:
                temporary.write_text(json.dumps(index, ensure_ascii=False), encoding='utf-8')
                temporary.replace(index_path)
            finally:
                temporary.unlink(missing_ok=True)
            for job_id in recovered:
                desktop.update(job_id, error=None)
        return {'directory':str(folder), 'files':copied, 'warnings':skipped}
