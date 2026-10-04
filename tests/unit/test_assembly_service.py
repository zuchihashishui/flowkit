import asyncio
import io
import json
import struct
import wave
import zlib
import pytest
from agent.services.assembly_service import AssemblyService, command, probe
from agent.api.assembly import Plan

SRT = b'1\n00:00:00,400 --> 00:00:01,300\nFirst scene\n\n2\n00:00:02,100 --> 00:00:03,200\nSecond scene\n'

class Upload:
    def __init__(self, name, data):
        self.filename, self.stream = name, io.BytesIO(data)
    async def read(self, n):
        return self.stream.read(n)

def png(color):
    def chunk(name, data):
        return struct.pack('!I', len(data)) + name + data + struct.pack('!I', zlib.crc32(name+data))
    data = b''.join(b'\0'+bytes(color)*64 for _ in range(36))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', 64,36,8,2,0,0,0)) + chunk(b'IDAT', zlib.compress(data)) + chunk(b'IEND', b'')

def wav(duration=3.7):
    out = io.BytesIO()
    with wave.open(out, 'wb') as f:
        f.setparams((1,2,16000,0,'NONE','not compressed'))
        f.writeframes(b'\0\0'*int(duration*16000))
    return out.getvalue()

async def inputs(tmp_path):
    service = AssemblyService(tmp_path/'jobs.db', tmp_path/'output with spaces')
    srt = await service.import_upload('srt', Upload('scenes.srt', SRT))
    audio = await service.import_upload('audio', Upload('narration.wav', wav()))
    red = await service.import_upload('image', Upload('001.png', png((255,0,0))))
    blue = await service.import_upload('image', Upload('002.png', png((0,0,255))))
    body = Plan(title='Demo', srt_id=srt['id'], audio_id=audio['id'], image_ids=[blue['id'],red['id']], size='720p', subtitles='soft').model_dump(mode='json')
    return service, body, red, blue

@pytest.mark.asyncio
async def test_number_mapping_gaps_tail_missing_and_duplicate_names(tmp_path):
    service, body, red, blue = await inputs(tmp_path)
    plan = service.plan(body)
    assert not plan['missing']
    assert plan['scenes'][0]['image_id'] == red['id']
    assert plan['scenes'][0]['image_start'] == 0
    assert plan['scenes'][0]['image_end'] == 2.1
    assert plan['scenes'][1]['image_end'] == 3.7
    incomplete = {**body, 'image_ids':[red['id']]}
    assert service.plan(incomplete)['missing'] == [2]
    with pytest.raises(ValueError, match='Select images'):
        service.enqueue(incomplete)
    duplicate = await service.import_upload('image', Upload('1.png', png((0,255,0))))
    ambiguous = {**body, 'image_ids':body['image_ids']+[duplicate['id']]}
    assert service.plan(ambiguous)['missing'] == [1]
    assert not service.plan({**ambiguous, 'mapping':{'1':red['id']}})['missing']
    assert service.plan({**body, 'mapping':{'1':blue['id']}})['scenes'][0]['image_id'] == blue['id']
    bad_srt = await service.import_upload('srt', Upload('too-long.srt', SRT.replace(b'00:00:03,200', b'00:00:10,000')))
    with pytest.raises(ValueError, match='audio lasts'):
        service.plan({**body, 'srt_id':bad_srt['id']})

@pytest.mark.asyncio
@pytest.mark.parametrize('subtitles,size,fit,width,height', [('off','720p','fit',1280,720),('soft','720p','fit',1280,720),('burn','720p','fit',1280,720),('off','vertical','crop',1080,1920)])
async def test_real_ffmpeg_render_duration_streams_and_scene_timing(tmp_path, subtitles, size, fit, width, height):
    service, body, red, blue = await inputs(tmp_path)
    body.update(subtitles=subtitles, font='DejaVu Sans',size=size,fit=fit)
    jid = service.enqueue(body)['id']
    await service.process(jid)
    job = service.jobs()[0]
    assert job['state'] == 'COMPLETED', job['error']
    assert job['progress'] == 100
    target = service.result_path(jid)
    info = await probe(target)
    assert abs(float(info['format']['duration']) - 3.7) < .1
    assert [s['codec_type'] for s in info['streams']] == (['video','audio','subtitle'] if subtitles=='soft' else ['video','audio'])
    assert info['streams'][0]['width'] == width
    assert info['streams'][0]['height'] == height
    # Opening silence and SRT gap keep the first image. Tail keeps the last.
    for second, channel in [(0.1,0),(1.7,0),(2.2,2),(3.5,2)]:
        raw = await command(['ffmpeg','-v','error','-ss',str(second),'-i',target,'-vf','crop=2:2:100:100','-frames:v','1','-threads','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'])
        assert len(raw)==12
        assert raw[channel] > 200 and raw[2-channel] < 30, (second, list(raw[:3]))
    assert not (target.parent/'frames').exists()
    assert (target.parent/'subtitles.srt').read_bytes() == SRT
    assert (target.parent/'timeline.json').exists()

@pytest.mark.asyncio
async def test_failed_cancelled_and_interrupted_jobs_keep_inputs(tmp_path, monkeypatch):
    service, body, _, _ = await inputs(tmp_path)
    async def fail(*args):
        raise ValueError('Encoder unavailable')
    monkeypatch.setattr(service, 'render', fail)
    jid = service.enqueue(body)['id'];await service.process(jid)
    assert service.jobs()[0]['state']=='FAILED'
    assert service.asset(body['audio_id'])
    queued = service.enqueue(body)['id'];await service.cancel(queued);await service.process(queued)
    assert next(j for j in service.jobs() if j['id']==queued)['state']=='CANCELLED'
    started=asyncio.Event()
    async def wait(*args):
        started.set();await asyncio.Event().wait()
    monkeypatch.setattr(service,'render',wait)
    running=service.enqueue(body)['id'];service.active=running;service.task=asyncio.create_task(service.process(running));await started.wait()
    await service.cancel(running)
    assert next(j for j in service.jobs() if j['id']==running)['state']=='CANCELLED'
    service.active=None;service.task=None
    restart_job=service.enqueue(body)['id'];started.clear()
    worker=asyncio.create_task(service.run());await asyncio.wait_for(started.wait(),2);worker.cancel()
    await asyncio.gather(worker,return_exceptions=True)
    assert next(j for j in service.jobs() if j['id']==restart_job)['state']=='INTERRUPTED'

@pytest.mark.asyncio
async def test_api_validation_and_incomplete_mapping_rejected(tmp_path, monkeypatch):
    import httpx
    from fastapi import FastAPI
    from agent.api import assembly
    service, body, red, blue = await inputs(tmp_path)
    monkeypatch.setattr(assembly, 'service', service)
    app = FastAPI();app.include_router(assembly.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        assert (await client.post('/assembly/preview',json=body)).status_code==200
        assert (await client.post('/assembly/jobs',json={**body,'image_ids':[red['id']]})).status_code==409
        for change in [{'audio_id':'../../private'},{'font':"Bad,Outline=99'"},{'fps':23},{'visual_mode':'intro'}]:
            assert (await client.post('/assembly/jobs',json={**body,**change})).status_code==422
        invalid=await client.post('/assembly/import/image',files={'file':('image.svg',b'<svg></svg>')})
        assert invalid.status_code==422
        queued=(await client.post('/assembly/jobs',json=body)).json()['id']
        assert (await client.get('/assembly/jobs/'+queued+'/video')).status_code==404
        assert (await client.post('/assembly/jobs/'+queued+'/cancel')).json()['cancelled']==1

async def clip_input(tmp_path, service, name='001.mp4', duration=.5):
    """A red-to-green clip with a loud tone; narration is silent to detect audio leaks."""
    target = tmp_path/name
    await command(['ffmpeg', '-v', 'error', '-y', '-filter_complex_threads', '1',
        '-f', 'lavfi', '-i', 'color=c=red:s=64x36:r=24:d=0.25',
        '-f', 'lavfi', '-i', f'color=c=lime:s=64x36:r=24:d={duration-.25}',
        '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=16000',
        '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a',
        '-t', str(duration), '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', target])
    return await service.import_upload('video', Upload(name, target.read_bytes()))


@pytest.mark.asyncio
async def test_optional_video_mapping_uses_whole_srt_scenes(tmp_path):
    service, body, red, blue = await inputs(tmp_path)
    clip = await clip_input(tmp_path, service)
    assert clip['metadata']['duration'] == .5
    # Images-only ignores optional videos, including a duplicate scene number.
    assert service.plan({**body, 'video_ids':[clip['id']]})['scenes'][0]['asset_id'] == red['id']
    mixed = {**body, 'visual_mode':'mixed', 'video_ids':[clip['id']]}
    assert service.plan(mixed)['missing'] == [1]  # 001.png and 001.mp4 are ambiguous.
    assert not service.plan({**mixed, 'mapping':{'1':clip['id']}})['missing']
    mapped = {**mixed, 'mapping':{'1':clip['id']}}
    plan = service.plan(mapped)
    assert [c['scene_key'] for c in plan['scenes']] == ['1','2']
    assert [c['asset_id'] for c in plan['scenes']] == [clip['id'],blue['id']]
    assert [(c['visual_start'],c['visual_end']) for c in plan['scenes']] == [(0,2.1),(2.1,3.7)]
    assert sum(c['frames'] for c in plan['scenes']) == 111
    assert plan['warnings'] and not plan['missing']
    assert service.path(service.asset(body['srt_id'])).read_bytes() == SRT
    with pytest.raises(ValueError, match='selected set'):
        service.plan({**mixed, 'mapping':{'1':body['audio_id']}})
    all_video = service.plan({**mixed,'image_ids':[], 'mapping':{'1':clip['id'],'2':clip['id']}})
    assert all(c['kind']=='video' for c in all_video['scenes']) and not all_video['missing']
    # A stale client cannot re-enable time-based scene splitting.
    for mode in ['intro','unknown']:
        with pytest.raises(ValueError):
            Plan(**{**body, 'visual_mode':mode})
        with pytest.raises(ValueError, match='preview the SRT scenes'):
            service.plan({**body, 'visual_mode':mode})
    assert 'video_duration_seconds' not in Plan.model_fields
    assert 'video_cutoff' not in plan



@pytest.mark.asyncio
@pytest.mark.parametrize('mode,clip_end,fps,subtitles,clip_duration', [
    ('mixed','freeze',30,'soft',.5), ('mixed','loop',24,'off',.5),
    ('mixed','freeze',60,'burn',4),
    ('only_video','loop',30,'off',.5)])
async def test_real_mixed_render_trim_loop_freeze_and_muted_clip_audio(tmp_path, mode, clip_end, fps, subtitles, clip_duration):
    service, body, red, blue = await inputs(tmp_path)
    clip = await clip_input(tmp_path, service, duration=clip_duration)
    body.update(visual_mode='mixed' if mode=='only_video' else mode, video_ids=[clip['id']],
                image_ids=[] if mode=='only_video' else [blue['id']], clip_end=clip_end,
                fps=fps, subtitles=subtitles, font='DejaVu Sans')
    if mode=='only_video':
        body['mapping']={'1':clip['id'],'2':clip['id']}
    plan = service.plan(body)
    assert not plan['missing']
    jid = service.enqueue(body)['id']
    await service.process(jid)
    assert service.jobs()[0]['state']=='COMPLETED', service.jobs()[0]['error']
    target = service.result_path(jid)
    info = await probe(target)
    assert abs(float(info['format']['duration']) - 3.7) < .1
    assert info['streams'][0]['width'] == 1280
    assert sum(s['codec_type']=='audio' for s in info['streams']) == 1
    assert any(s['codec_type']=='subtitle' for s in info['streams']) == (subtitles=='soft')
    # Original narration is silence. The clip's tone must not leak into the output.
    raw = await command(['ffmpeg','-v','error','-i',target,'-map','0:a:0','-f','s16le','-ac','1','-ar','16000','pipe:1'])
    assert max(abs(x[0]) for x in struct.iter_unpack('<h',raw)) <= 1
    checks=[(.1,0),(.4,1)]
    checks += [(1.1, 0 if clip_end=='loop' else 1)]
    if mode!='only_video':
        checks += [(2.2,2),(3.5,2)]
    for second,channel in checks:
        pixels = await command(['ffmpeg','-v','error','-ss',str(second),'-i',target,'-vf','crop=2:2:100:100','-frames:v','1','-threads','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'])
        assert len(pixels)==12 and pixels[channel]>200, (second,list(pixels[:3]))
        assert all(pixels[i]<30 for i in range(3) if i!=channel), (second,list(pixels[:3]))
    assert (target.parent/'subtitles.srt').read_bytes() == SRT
    assert not (target.parent/'clips').exists()
    assert not (target.parent/'frames').exists()


@pytest.mark.asyncio
async def test_video_import_preview_ranges_and_invalid_media(tmp_path, monkeypatch):
    import httpx
    from fastapi import FastAPI
    from agent.api import assembly
    service, body, _, _ = await inputs(tmp_path)
    clip = await clip_input(tmp_path, service)
    monkeypatch.setattr(assembly,'service',service)
    app=FastAPI();app.include_router(assembly.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        assert (await client.get('/assembly/status')).json()['mixed_media_version']==1
        response=await client.get('/assembly/clips/'+clip['id']+'/video',headers={'Range':'bytes=0-99'})
        assert response.status_code==206 and len(response.content)==100
        assert (await client.get('/assembly/clips/'+body['audio_id']+'/video')).status_code==404
        result=await client.post('/assembly/import/video', files={'file':('broken.mp4',b'not video')})
        assert result.status_code==422
        assert len(service.assets())==5
        assert not list((service.output/'assets').glob('*.part'))


@pytest.mark.asyncio
async def test_preflight_reports_missing_corrupt_low_resolution_and_short_clips(tmp_path):
    from agent.services.assembly_preflight import check
    service, body, red, blue = await inputs(tmp_path)
    clip = await clip_input(tmp_path, service)
    body.update(visual_mode='mixed',video_ids=[clip['id']],mapping={'1':clip['id']})
    report = await check(service,body)
    assert not report['blocked']
    assert any('hold last frame' in m for c in report['checks'] for m in c['messages'])
    assert any(c['width']==64 and c['status']=='WARNING' for c in report['checks'])
    service.path(blue).write_bytes(b'corrupt image')
    report = await check(service,body)
    assert report['blocked'] and report['checks'][-1]['status']=='ERROR'
    service.path(blue).unlink()
    report = await check(service,body)
    assert report['blocked'] and 'missing' in report['checks'][-1]['messages'][0]


@pytest.mark.asyncio
@pytest.mark.parametrize('corrupt_cache',[False,True])
async def test_render_resume_reuses_only_verified_completed_scenes(tmp_path,monkeypatch,corrupt_cache):
    from agent.services import assembly_service as module
    service, body, _, _ = await inputs(tmp_path)
    jid = service.enqueue(body)['id']
    real_command = module.command
    attempts=[];fail=True
    async def interrupted(args,**kwargs):
        nonlocal fail
        target=str(args[-1])
        if args[0]=='ffmpeg' and '/clips/' in target and target.endswith('.part.mp4'):
            attempts.append(target)
            if '00001.part.mp4' in target and fail:
                fail=False
                raise ValueError('Simulated encoder interruption')
        return await real_command(args,**kwargs)
    monkeypatch.setattr(module,'command',interrupted)
    await service.process(jid)
    assert service.jobs()[0]['state']=='FAILED'
    assert service.jobs()[0]['saved_scenes']==1
    assert (service.output/jid/'clips/00000.mp4').is_file()
    if corrupt_cache:(service.output/jid/'clips/00000.mp4').write_bytes(b'bad checkpoint')
    service.resume(jid)
    await service.process(jid)
    assert service.jobs()[0]['state']=='COMPLETED',service.jobs()[0]['error']
    first_attempts=[p for p in attempts if '00000.part.mp4' in p]
    assert len(first_attempts)==(2 if corrupt_cache else 1)
    assert service.jobs()[0]['saved_scenes']==0
    with pytest.raises(ValueError,match='Only failed'):
        service.resume(jid)
