"""Read-only checks of the actual selected files before local rendering."""
import asyncio
import math
from agent.services.assembly_service import probe, SIZES


async def check(service, body):
    plan = service.plan(body)
    checks, cache = [], {}
    width, height = SIZES[body['size']]
    for aid in dict.fromkeys([body['audio_id'], *[c['asset_id'] for c in plan['scenes'] if c['asset_id']]]):
        asset = service.asset(aid)
        try:
            path = service.path(asset)
            if not path.is_file() or not path.stat().st_size:
                raise ValueError('Saved file is missing or empty. Import or generate it again.')
            info = await probe(path)
            wanted = 'audio' if asset['kind'] == 'audio' else 'video'
            stream = next((s for s in info.get('streams',[]) if s['codec_type'] == wanted), None)
            if not stream:
                raise ValueError('File has no readable '+wanted+' stream.')
            if wanted == 'video' and (not stream.get('width') or not stream.get('height')):
                raise ValueError('Visual file has no readable dimensions; it may be corrupt.')
            duration = float(stream.get('duration') or info.get('format',{}).get('duration') or 0)
            if asset['kind'] in {'audio','video'} and (not math.isfinite(duration) or duration <= 0):
                raise ValueError('File duration is unreadable.')
            if asset['kind'] == 'audio' and abs(duration-plan['duration']) > .1:
                raise ValueError('Narration changed after import. Import the audio again.')
            cache[aid] = {'duration':duration,'width':stream.get('width'),'height':stream.get('height')}
        except (ValueError, OSError, asyncio.TimeoutError) as error:
            cache[aid] = {'error':str(error) or 'File check timed out.'}
    audio = cache[body['audio_id']]
    if audio.get('error'):
        checks.append({'scene':None,'status':'ERROR','messages':['Narration: '+audio['error']]})
    for scene in plan['scenes']:
        info = cache.get(scene['asset_id'],{})
        messages, status = [], 'OK'
        if not scene['asset_id']:
            messages.append('Choose an image or video.');status='ERROR'
        elif info.get('error'):
            messages.append(info['error']);status='ERROR'
        else:
            if info.get('width',0) < width or info.get('height',0) < height:
                messages.append('Source resolution is smaller than the output; it may look soft.');status='WARNING'
            if scene['kind'] == 'video':
                target = scene['frames']/body['fps']
                if info['duration']+.001 < target:
                    messages.append(f"Clip {info['duration']:.3f}s → scene {target:.3f}s: {'loop' if body.get('clip_end')=='loop' else 'hold last frame'}.");status='WARNING'
                elif info['duration'] > target+.001:
                    messages.append(f"Trim clip {info['duration']:.3f}s to {target:.3f}s.")
            if not messages:messages.append('File is readable and ready.')
        checks.append({'scene':scene['index'],'asset_id':scene['asset_id'],'status':status,'messages':messages,
                       'width':info.get('width'),'height':info.get('height'),'duration':info.get('duration')})
    return {**plan,'checks':checks,'blocked':any(c['status']=='ERROR' for c in checks),
            'check_note':'Checks inspect file headers and streams. Rendering performs full decoding.'}
