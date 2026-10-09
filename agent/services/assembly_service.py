"""Local image/video assembly. Immutable inputs, SRT timeline and one FFmpeg job at a time."""
from agent.services import workflow_scope as scope

import asyncio
from contextlib import contextmanager
import json
import math
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import time
import uuid

from agent.config import BASE_DIR, OUTPUT_DIR
from agent.services.srt_service import parse_srt

EXTENSIONS = {'srt': {'.srt'}, 'audio': {'.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus'},
              'image': {'.png', '.jpg', '.jpeg', '.webp'},
              'video': {'.mp4', '.mov', '.mkv', '.webm', '.m4v'}}
SIZES = {'1080p': (1920, 1080), '720p': (1280, 720), 'vertical': (1080, 1920)}


def image_motion_filter(width, height, fps, frames, fit, motion):
    """A centered 10% zoom over exactly one scene, sampled at output frame times.

    Work at double resolution to reduce integer crop jitter. Fit scales the image
    inside a padded canvas so even the closest frame retains the whole image;
    crop fills the canvas throughout. One-frame scenes use the starting framing.
    """
    if motion not in {'zoom_in', 'zoom_out'}:
        raise ValueError('Choose None, Slow zoom in or Slow zoom out for still images.')
    work_width, work_height = width * 2, height * 2
    if fit == 'fit':
        fit_width = 2 * math.floor(work_width / 1.1 / 2)
        fit_height = 2 * math.floor(work_height / 1.1 / 2)
        framing = (f'scale={fit_width}:{fit_height}:force_original_aspect_ratio=decrease,'
                   f'pad={work_width}:{work_height}:(ow-iw)/2:(oh-ih)/2:color=black')
    else:
        framing = (f'scale={work_width}:{work_height}:force_original_aspect_ratio=increase,'
                   f'crop={work_width}:{work_height}')
    progress = f'min(on/{max(1, frames-1)},1)'
    zoom = f'1+0.1*{progress}' if motion == 'zoom_in' else f'1.1-0.1*{progress}'
    return (f"{framing},setsar=1,zoompan=z='{zoom}':x='iw/2-iw/zoom/2':"
            f"y='ih/2-ih/zoom/2':d={frames}:s={width}x{height}:fps={fps},"
            'setsar=1,format=yuv420p')


def cues_from_srt(data):
    text, _ = parse_srt(data.decode('utf-8-sig'))
    cues = []
    for block in re.split(r'\n[ \t]*\n', text.strip()):
        lines = block.splitlines()
        def seconds(value):
            h, m, s, ms = map(int, re.split('[:,]', value))
            return h * 3600 + m * 60 + s + ms / 1000
        start, end = lines[1].split(' --> ')
        cues.append({'index': int(lines[0]), 'start': seconds(start), 'end': seconds(end), 'text': '\n'.join(lines[2:])})
    if len(cues) > 3000:
        raise ValueError('This assembly supports up to 3,000 subtitle cues.')
    return text, cues


def natural_key(asset):
    return [(0, int(s)) if s.isdigit() else (1, s.casefold()) for s in re.split(r'(\d+)', asset['title'])]


async def stop_process(proc):
    if proc and proc.returncode is None:
        try:
            proc.terminate()
        except ProcessLookupError:
            return
        try:
            await asyncio.wait_for(proc.wait(), 5)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()


async def command(args, cwd=None, timeout=60):
    proc = await asyncio.create_subprocess_exec(*map(str, args), cwd=cwd,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
        if proc.returncode:
            raise ValueError(err.decode('utf-8', errors='replace')[-2500:] or 'Media command failed.')
        return out
    finally:
        await stop_process(proc)


async def probe(path):
    if not shutil.which('ffprobe'):
        raise ValueError('FFprobe is missing. Install FFmpeg and restart Studio.')
    raw = await command(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-show_format', '-of', 'json', path])
    return json.loads(raw)


class AssemblyService:
    def __init__(self, store=None, output=None):
        self.store = Path(store or BASE_DIR / 'assembly_jobs.db')
        self.output = Path(output or OUTPUT_DIR / 'assembly')
        self.active = None
        self.task = None
        self.stopping = False

    @contextmanager
    def db(self):
        self.store.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.store)
        db.row_factory = sqlite3.Row
        db.executescript('''CREATE TABLE IF NOT EXISTS assembly_assets
            (id TEXT PRIMARY KEY, kind TEXT, title TEXT, filename TEXT, metadata TEXT, created REAL);
            CREATE TABLE IF NOT EXISTS assembly_jobs
            (id TEXT PRIMARY KEY, title TEXT, state TEXT, phase TEXT, progress REAL, plan TEXT,
             error TEXT, created REAL, updated REAL);''')
        scope.initialize(db)
        try:
            with db:
                yield db
        finally:
            db.close()

    def assets(self):
        with self.db() as db:
            return [{**dict(r), 'metadata': json.loads(r['metadata'])} for r in db.execute('SELECT * FROM assembly_assets ORDER BY created DESC')]

    def asset(self, aid, kind=None):
        with self.db() as db:
            row = db.execute('SELECT * FROM assembly_assets WHERE id=?', (aid,)).fetchone()
        if not row or (kind and row['kind'] != kind):
            raise ValueError('Selected input is not available. Choose it again.')
        return {**dict(row), 'metadata': json.loads(row['metadata'])}

    def path(self, asset):
        return self.output / 'assets' / asset['filename']

    async def import_upload(self, kind, upload, context=None, sources=(), metadata_extra=None):
        name = (upload.filename or '').replace('\\', '/').rsplit('/', 1)[-1]
        suffix = Path(name).suffix.lower()
        if suffix not in EXTENSIONS.get(kind, set()):
            raise ValueError('Unsupported input format for ' + kind + '.')
        aid = str(uuid.uuid4())
        folder = self.output / 'assets'
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / (aid + suffix)
        part = target.with_suffix('.part')
        size = 0
        try:
            with part.open('wb') as stream:
                while data := await upload.read(1024 * 1024):
                    size += len(data)
                    if kind == 'srt' and size > 8 * 1024 * 1024:
                        raise ValueError('SRT is larger than 8 MiB.')
                    stream.write(data)
            if not size:
                raise ValueError('The selected file is empty.')
            part.replace(target)
            metadata = {**(metadata_extra or {}), 'bytes': size}
            if kind == 'srt':
                normalized, cues = cues_from_srt(target.read_bytes())
                target.write_text(normalized, encoding='utf-8')
                metadata.update(cues=len(cues), end=cues[-1]['end'])
            elif kind == 'audio':
                info = await probe(target)
                streams = [s for s in info['streams'] if s['codec_type'] == 'audio']
                duration = float(streams[0].get('duration') or info.get('format', {}).get('duration') or 0) if streams else 0
                if not math.isfinite(duration) or duration <= 0:
                    raise ValueError('The file does not contain audio with a readable duration.')
                metadata['duration'] = duration
            else:
                if not shutil.which('ffmpeg'):
                    raise ValueError('FFmpeg is missing. Install FFmpeg and restart Studio.')
                if kind == 'video':
                    info = await probe(target)
                    stream = next((s for s in info['streams'] if s['codec_type'] == 'video' and not s.get('disposition', {}).get('attached_pic')), {})
                    duration = float(stream.get('duration') or info.get('format', {}).get('duration') or 0) if stream else 0
                    if not math.isfinite(duration) or duration <= 0:
                        raise ValueError('The file does not contain video with a readable duration.')
                    metadata.update(duration=duration, width=stream['width'], height=stream['height'])
                await command(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-threads', '2',
                    '-protocol_whitelist', 'file,pipe', '-i', target, '-vf', 'scale=256:144:force_original_aspect_ratio=decrease,pad=256:144:(ow-iw)/2:(oh-ih)/2',
                    '-frames:v', '1', '-threads', '2', folder / (aid + '-thumb.jpg')])
            with self.db() as db:
                db.execute('INSERT INTO assembly_assets VALUES(?,?,?,?,?,?)', (aid, kind, name[:240], target.name, json.dumps(metadata), time.time()))
                scope.record(db, 'asset', aid, context, sources)
            return self.asset(aid)
        except BaseException:
            target.unlink(missing_ok=True)
            (folder / (aid + '-thumb.jpg')).unlink(missing_ok=True)
            raise
        finally:
            part.unlink(missing_ok=True)

    async def use_source(self, kind, source_id, context=None):
        # IDs resolve only through existing services; no user-provided filesystem paths.
        if kind == 'srt':
            from agent.services.srt_service import service
            path = service.result_path(source_id, require_approved=True)
            parent = scope.ref('srt', source_id)
        else:
            from agent.services.whisperx_service import service
            _, path = service.resolve_source(source_id)
            parent = scope.audio_ref(service, source_id)
        class Reader:
            filename = ('subtitles-' + source_id + '.srt') if kind == 'srt' else ('narration-' + source_id + path.suffix)
            async def read(self, n):
                return stream.read(n)
        with path.open('rb') as stream:
            return await self.import_upload(kind, Reader(), context, [parent])

    def plan(self, body):
        image_motion = body.get('image_motion', 'none')
        if image_motion not in {'none', 'zoom_in', 'zoom_out'}:
            raise ValueError('Choose None, Slow zoom in or Slow zoom out for still images.')
        audio = self.asset(body['audio_id'], 'audio')
        subtitle = self.asset(body['srt_id'], 'srt')
        _, cues = cues_from_srt(self.path(subtitle).read_bytes())
        images = [self.asset(aid, 'image') for aid in dict.fromkeys(body.get('image_ids', []))]
        images.sort(key=natural_key)
        mode = body.get('visual_mode', 'images')
        if mode not in {'images', 'mixed'}:
            raise ValueError('Choose Images only or Images + video and preview the SRT scenes again.')
        videos = [self.asset(aid, 'video') for aid in dict.fromkeys(body.get('video_ids', []))] if mode != 'images' else []
        videos.sort(key=natural_key)
        visuals = sorted(images + videos, key=natural_key)
        duration = audio['metadata']['duration']
        if cues[-1]['end'] > duration + .1:
            raise ValueError(f'SRT ends at {cues[-1]["end"]:.3f}s but audio lasts {duration:.3f}s. Choose matching files or correct the SRT.')
        overrides = body.get('mapping', {})
        assets = {a['id']: a for a in visuals}
        frames = math.ceil(duration * body['fps'])
        scenes, warnings = [], []
        numbered = {}
        for asset in visuals:
            stem = Path(asset['title']).stem
            if stem.isdecimal():
                numbered.setdefault(int(stem), []).append(asset['id'])
        for n, cue in enumerate(cues):
            start = 0 if n == 0 else round(cue['start'] * body['fps'])
            end = round(cues[n+1]['start'] * body['fps']) if n+1 < len(cues) else frames
            if end <= start:
                raise ValueError(f'Scene {cue["index"]} is shorter than one frame at the selected frame rate.')
            key = str(cue['index'])
            candidates = numbered.get(cue['index'], [])
            if key in overrides:
                aid = overrides[key]
            elif body['mapping_mode'] == 'order':
                aid = visuals[n]['id'] if n < len(visuals) else None
            else:
                aid = candidates[0] if len(candidates) == 1 else None
            if aid and aid not in assets:
                raise ValueError('Scene media does not belong to the selected set or match the required media type.')
            asset = assets.get(aid, {})
            kind = asset.get('kind')
            clip_action = None
            if kind == 'video':
                clip_action = body.get('clip_end', 'freeze') if asset['metadata']['duration'] < (end-start)/body['fps'] else 'trim'
                if clip_action != 'trim':
                    warnings.append(f'Scene {key}: short clip will {"hold its last frame" if clip_action == "freeze" else "loop"}.')
            scenes.append({**cue, 'scene_key': key, 'asset_id': aid, 'kind': kind, 'allowed_kind': 'image' if mode == 'images' else 'any',
                'image_id': aid if kind == 'image' else None, 'clip_action': clip_action,
                'image_motion': image_motion if kind == 'image' else 'none',
                'start_frame': start, 'frames': end-start, 'visual_start': start/body['fps'], 'visual_end': end/body['fps'],
                'image_start': start/body['fps'], 'image_end': end/body['fps']})
        used = {c['asset_id'] for c in scenes}
        return {**body, 'image_motion': image_motion, 'duration': duration, 'audio_title': audio['title'], 'srt_title': subtitle['title'],
            'scenes': scenes, 'missing': [c['index'] for c in scenes if not c['asset_id']],
            'unused': [a['title'] for a in visuals if a['id'] not in used], 'warnings': warnings,
            'timeline_note': 'Each SRT scene uses one image or video. Visuals cover the full narration; each stays until the next cue starts. The SRT is unchanged. Boundaries are rounded to the frame rate. Clip audio is muted; only narration is used.' +
                (f' Still images use slow zoom {"in" if image_motion == "zoom_in" else "out"}; video clips keep their original motion.' if image_motion != 'none' else '')}

    def enqueue(self, body, context=None):
        plan = self.plan(body)
        if plan['missing']:
            noun = 'images' if body.get('visual_mode', 'images') == 'images' else 'media'
            raise ValueError(f'Select {noun} for scenes: ' + ', '.join(map(str, plan['missing'][:30])))
        if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
            raise ValueError('Install FFmpeg and FFprobe and restart Studio.')
        plan['render_version'] = 2
        jid, now = str(uuid.uuid4()), time.time()
        with self.db() as db:
            db.execute('INSERT INTO assembly_jobs VALUES(?,?,?,?,?,?,?,?,?)',
                (jid, body['title'], 'QUEUED', 'Queued', 0, json.dumps(plan, ensure_ascii=False), None, now, now))
            scope.record(db, 'assembly', jid, context, [scope.ref('asset', i) for i in dict.fromkeys([body['audio_id'],body['srt_id'],*body.get('image_ids', []),*body.get('video_ids', [])])])
        return {'id': jid}

    def jobs(self, filters=None):
        where, params = scope.job_filter('assembly', 'id', filters)
        with self.db() as db:
            jobs = [dict(r) for r in db.execute(f'SELECT id,title,state,phase,progress,error,created,updated FROM assembly_jobs {where} ORDER BY created DESC LIMIT 500', params)]
        from agent.services import render_cache
        for job in jobs:
            job['saved_scenes'] = len(render_cache.read(self.output/job['id']))
            job['can_resume'] = job['state'] in {'FAILED','CANCELLED','INTERRUPTED'}
        return jobs

    def update(self, jid, **values):
        values['updated'] = time.time()
        with self.db() as db:
            db.execute('UPDATE assembly_jobs SET ' + ','.join(k+'=?' for k in values) + ' WHERE id=?', (*values.values(), jid))

    def result_path(self, jid):
        with self.db() as db:
            row = db.execute('SELECT state FROM assembly_jobs WHERE id=?', (jid,)).fetchone()
        if not row or row['state'] != 'COMPLETED':
            raise ValueError('The rendered MP4 is not available yet.')
        return self.output / jid / 'video.mp4'

    async def cancel(self, jid):
        with self.db() as db:
            changed = db.execute("UPDATE assembly_jobs SET state='CANCELLED',phase='Cancelled',updated=? WHERE id=? AND state='QUEUED'", (time.time(), jid)).rowcount
        if jid == self.active and self.task:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
            changed = 1
        return {'cancelled': changed}

    def resume(self, jid):
        with self.db() as db:
            changed = db.execute("UPDATE assembly_jobs SET state='QUEUED',phase='Queued for resume',error=NULL,updated=? WHERE id=? AND state IN ('FAILED','CANCELLED','INTERRUPTED')", (time.time(),jid)).rowcount
        if not changed:
            raise ValueError('Only failed, cancelled or interrupted renders can resume.')
        return {'id':jid,'resumed':True}

    async def render(self, jid, plan):
        from agent.services.assembly_preflight import check
        checked = await check(self, plan)
        if checked['blocked']:
            raise ValueError('Preflight failed: ' + '; '.join(m for c in checked['checks'] if c['status']=='ERROR' for m in c['messages']))
        folder = self.output / jid
        folder.mkdir(parents=True, exist_ok=True)
        frames_dir = folder / 'frames'
        frames_dir.mkdir(exist_ok=True)
        width, height = SIZES[plan['size']]
        mode = plan['fit']
        scale = (f'scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black' if mode == 'fit'
                 else f'scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height}') + ',setsar=1'
        has_video = plan.get('render_version') == 2 or plan.get('image_motion', 'none') != 'none' or any(c.get('kind') == 'video' for c in plan['scenes'])
        lines = ['ffconcat version 1.0']
        render_start = 55 if has_video else 10
        if has_video:
            clips_dir = folder / 'clips'
            clips_dir.mkdir(exist_ok=True)
            from agent.services import render_cache
            checkpoints, digests = render_cache.read(folder), {}
            for n, cue in enumerate(plan['scenes']):
                self.update(jid, phase=f"Preparing scene {n+1}/{len(plan['scenes'])}", progress=55*n/len(plan['scenes']))
                asset = self.asset(cue['asset_id'], cue['kind'])
                if asset['id'] not in digests:
                    digests[asset['id']] = await asyncio.to_thread(render_cache.digest, self.path(asset))
                key = render_cache.key(plan, cue, digests[asset['id']])
                target = clips_dir / f'{n:05d}.mp4'
                saved = checkpoints.get(str(n), {})
                if saved.get('key') == key and target.is_file() and saved.get('sha256') == await asyncio.to_thread(render_cache.digest, target):
                    self.update(jid, phase=f"Reusing saved scene {n+1}/{len(plan['scenes'])}")
                    lines.append(f'file clips/{n:05d}.mp4')
                    continue
                part = clips_dir / f'{n:05d}.part.mp4'
                args = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-threads', '2', '-protocol_whitelist', 'file,pipe']
                if cue['kind'] == 'image':
                    args += ['-loop', '1', '-framerate', str(plan['fps'])]
                elif plan.get('clip_end', 'freeze') == 'loop':
                    args += ['-stream_loop', '-1']
                args += ['-i', self.path(asset), '-map', '0:v:0', '-an', '-sn', '-dn']
                vf = f"setpts=PTS-STARTPTS,{scale},fps={plan['fps']},format=yuv420p"
                if cue['kind'] == 'image' and plan.get('image_motion', 'none') != 'none':
                    vf = image_motion_filter(width, height, plan['fps'], cue['frames'], mode, plan['image_motion'])
                if cue['kind'] == 'video' and plan.get('clip_end', 'freeze') == 'freeze':
                    vf += f",tpad=stop_mode=clone:stop_duration={cue['frames']/plan['fps']}"
                args += ['-vf', vf, '-filter_threads', '2', '-frames:v', str(cue['frames']),
                         '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-threads', '4',
                         '-video_track_timescale', '90000', part]
                await command(args, timeout=6*3600)
                clip_info = await probe(part)
                stream = next((s for s in clip_info['streams'] if s['codec_type']=='video'), {})
                if stream.get('width') != width or stream.get('height') != height or int(stream.get('nb_frames',0)) != cue['frames']:
                    raise ValueError(f'Scene {n+1} did not render all expected frames.')
                part.replace(target)
                checkpoints[str(n)] = {'key':key,'sha256':await asyncio.to_thread(render_cache.digest,target)}
                render_cache.save(folder, checkpoints)
                lines.append(f'file clips/{n:05d}.mp4')
        else:
            # Keep the existing image-only renderer, including plans queued by older releases.
            ids = list(dict.fromkeys(c['image_id'] for c in plan['scenes']))
            for n, aid in enumerate(ids):
                self.update(jid, phase=f'Preparing image {n+1}/{len(ids)}', progress=10*n/len(ids))
                await command(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-threads', '2', '-protocol_whitelist', 'file,pipe',
                    '-i', self.path(self.asset(aid, 'image')), '-vf', scale, '-frames:v', '1', '-threads', '2', frames_dir/(aid+'.png')])
            for cue in plan['scenes']:
                lines += [f"file frames/{cue['image_id']}.png", f"option framerate {plan['fps']}", f"duration {cue['frames']/plan['fps']:.9f}"]
            lines += [f"file frames/{plan['scenes'][-1]['image_id']}.png", f"option framerate {plan['fps']}"]
        (folder/'timeline.txt').write_text('\n'.join(lines)+'\n', encoding='utf-8')
        (folder/'timeline.json').write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding='utf-8')
        (folder/'subtitles.srt').write_bytes(self.path(self.asset(plan['srt_id'], 'srt')).read_bytes())
        args = ['ffmpeg', '-hide_banner', '-loglevel', 'warning', '-y', '-threads', '2', '-f', 'concat', '-safe', '0', '-protocol_whitelist', 'file,pipe',
                '-i', 'timeline.txt', '-protocol_whitelist', 'file,pipe', '-i', str(self.path(self.asset(plan['audio_id'], 'audio')).resolve())]
        if plan['subtitles'] == 'soft':
            args += ['-i', 'subtitles.srt']
        args += ['-map', '0:v:0', '-map', '1:a:0']
        if plan['subtitles'] == 'soft':
            args += ['-map', '2:0', '-c:s', 'mov_text', '-metadata:s:s:0', 'title=Subtitles', '-disposition:s:0', 'default']
        video_filter = f"fps={plan['fps']},format=yuv420p"
        if plan['subtitles'] == 'burn':
            video_filter += ",subtitles=filename=subtitles.srt:force_style='FontName=" + plan['font'] + ",FontSize=20,Outline=1.5,MarginV=24'"
        if has_video and plan['subtitles'] != 'burn':
            args += ['-c:v', 'copy']
        else:
            args += ['-vf', video_filter, '-filter_threads', '2', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-threads', '8']
        args += ['-c:a', 'aac', '-b:a', '192k', '-t', str(plan['duration']), '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', 'video.part.mp4']
        self.update(jid, phase='Rendering video', progress=render_start)
        with (folder/'ffmpeg.log').open('wb') as log:
            proc = await asyncio.create_subprocess_exec(*args, cwd=folder, stdout=asyncio.subprocess.PIPE, stderr=log,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            try:
                last_update = 0
                while line := await proc.stdout.readline():
                    if line.startswith(b'out_time_us=') and time.monotonic()-last_update > .5:
                        try:
                            seconds = int(line.split(b'=')[1])/1000000
                            self.update(jid, progress=min(98, render_start+(98-render_start)*seconds/plan['duration']))
                            last_update = time.monotonic()
                        except ValueError:
                            pass
                await proc.wait()
                if proc.returncode:
                    raise ValueError((folder/'ffmpeg.log').read_text(encoding='utf-8', errors='replace')[-2500:])
            finally:
                await stop_process(proc)
        self.update(jid, phase='Verifying MP4', progress=99)
        info = await probe(folder/'video.part.mp4')
        video = next((s for s in info['streams'] if s['codec_type']=='video'), {})
        if video.get('width') != width or video.get('height') != height or not any(s['codec_type']=='audio' for s in info['streams']):
            raise ValueError('Rendered MP4 is missing the expected video or audio stream.')
        if abs(float(info['format']['duration'])-plan['duration']) > max(.2, 2/plan['fps']):
            raise ValueError('Rendered duration does not match the narration.')
        (folder/'video.part.mp4').replace(folder/'video.mp4')
        shutil.rmtree(frames_dir)
        shutil.rmtree(folder/'clips', ignore_errors=True)
        (folder/'checkpoints.json').unlink(missing_ok=True)
        self.update(jid, state='COMPLETED', phase='Completed', progress=100)

    async def process(self, jid):
        with self.db() as db:
            if not db.execute("UPDATE assembly_jobs SET state='RUNNING' WHERE id=? AND state='QUEUED'", (jid,)).rowcount:
                return
            row = db.execute('SELECT plan FROM assembly_jobs WHERE id=?', (jid,)).fetchone()
        self.update(jid, state='RUNNING', phase='Preparing media', error=None)
        try:
            await asyncio.wait_for(self.render(jid, json.loads(row['plan'])), 6*3600)
        except asyncio.CancelledError:
            self.update(jid, state='INTERRUPTED' if self.stopping else 'CANCELLED', phase='Stopped', error='Rendering stopped. Original inputs are retained.')
            raise
        except Exception as e:
            self.update(jid, state='FAILED', phase='Failed', error=str(e) or 'Rendering timed out after 6 hours.')
        finally:
            (self.output/jid/'video.part.mp4').unlink(missing_ok=True)
            shutil.rmtree(self.output/jid/'frames', ignore_errors=True)
            for part in (self.output/jid/'clips').glob('*.part.mp4'):
                part.unlink(missing_ok=True)

    async def run(self):
        self.stopping = False
        with self.db() as db:
            db.execute("UPDATE assembly_jobs SET state='INTERRUPTED',phase='Interrupted',error='Backend restarted during rendering. Resume to reuse verified saved scenes.' WHERE state='RUNNING'")
        try:
            while True:
                queued = [j for j in reversed(self.jobs()) if j['state']=='QUEUED']
                if queued:
                    self.active = queued[0]['id']
                    self.task = asyncio.create_task(self.process(self.active))
                    await asyncio.shield(asyncio.gather(self.task, return_exceptions=True))
                    self.task = None
                    self.active = None
                await asyncio.sleep(1)
        finally:
            self.stopping = True
            if self.task:
                self.task.cancel()
                await asyncio.gather(self.task, return_exceptions=True)
            self.active = None


service = AssemblyService()
