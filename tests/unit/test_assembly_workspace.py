"""Project/video source loading and durable output routing, with real media files."""
import json
from pathlib import Path
import pytest
from agent.api import storyboard, desktop
from agent.db import crud
from agent.services import video_files, workflow_scope as scope
from agent.services.assembly_service import AssemblyService, probe
from agent.services.concept_writer import Concept
from tests.unit.test_workflow_scope import env, post, finish_audio, finish_json, finish_srt, OPTIONS, SRT
from tests.unit.test_assembly_service import Upload, wav, png


async def scene_image(env, tmp_path, monkeypatch):
    root = tmp_path/'generated'; root.mkdir()
    monkeypatch.setattr(desktop, 'ROOT', root)
    await storyboard.save_document(env.a['video_id'], storyboard.DocumentBody())
    data = await storyboard.import_segments(env.a['video_id'], storyboard.ImportBody(format='srt', content=SRT))
    scene = data['segments'][0]
    await storyboard.save_concept(scene['id'], Concept(title='Sea', description='Sea.', image_prompt='Blue sea.', video_prompt='Waves.'))
    data = await storyboard.read_document(env.a['video_id']); scene = data['segments'][0]
    path = root/'001.png'; path.write_bytes(png((0, 0, 255)))
    payload = {**env.a, 'document_id':data['document']['id'], 'segment_id':scene['id'],
        'concept_id':scene['active_concept_id'], 'kind':'image', 'prompt':'Blue sea.', 'start_ms':0, 'end_ms':2000}
    with desktop.connection() as db:
        db.execute("INSERT INTO jobs(id,payload,state,files,created) VALUES(?,?,'COMPLETED',?,1)", ('media',json.dumps(payload),json.dumps([str(path)])))
    return scene, path


@pytest.mark.asyncio
async def test_project_load_uses_direct_scene_srt_scoped_audio_and_current_media_without_duplicates(env, tmp_path, monkeypatch):
    scene, original = await scene_image(env, tmp_path, monkeypatch)
    audio = await env.wx.import_audio(Upload('日本語.wav', wav(2)), env.a)
    # A newer audio in another video must never be selected.
    await env.wx.import_audio(Upload('Wrong.wav', wav(5)), env.b)
    loaded = await post(env, 'assembly/project-sources', env.a)
    assert loaded['srt_id'] and loaded['audio_id'] and len(loaded['assets']) == 1
    assert loaded['mapping'] == {'1':loaded['assets'][0]['id']} and not loaded['issues']
    assert env.va.path(env.va.asset(loaded['srt_id'])).read_text() == SRT
    assert env.va.asset(loaded['audio_id'])['metadata']['duration'] == 2
    assert scope.resource('asset', loaded['audio_id'])['sources'] == [scope.ref('audio', audio['id'])]
    folder = Path((await video_files.folders(**env.a))['directory'])
    assert loaded['output_directory'] == str(folder/'exports')
    for asset in env.va.assets():
        assert env.va.path(asset).is_relative_to(folder)
    thumb = await env.client.get('/api/assembly/images/'+loaded['assets'][0]['id']+'/thumbnail')
    assert thumb.status_code == 200 and thumb.headers['content-type'] == 'image/jpeg'
    again = await post(env, 'assembly/project-sources', env.a)
    assert (again['srt_id'],again['audio_id'],again['mapping']) == (loaded['srt_id'],loaded['audio_id'],loaded['mapping'])
    assert len(env.va.assets()) == 3
    empty = await post(env, 'assembly/project-sources', env.b)
    assert empty['srt_id'] is None and not empty['assets']
    assert empty['audio_id'] != loaded['audio_id']
    wrong = await env.client.post('/api/assembly/project-sources',json={**env.a,'video_id':env.b['video_id']})
    assert wrong.status_code == 409
    assert (await env.client.post('/api/assembly/project-sources',json={})).status_code == 409
    # Changed prompts cannot silently reuse old scene media.
    await storyboard.save_concept(scene['id'], Concept(title='Forest',description='Trees.',image_prompt='Forest.',video_prompt='Leaves.'))
    stale = await post(env, 'assembly/project-sources', env.a)
    assert not stale['assets'] and stale['mapping'] == {'1':None}
    assert original.is_file()


@pytest.mark.asyncio
async def test_load_prefers_srt_audio_lineage_over_newer_narration(env):
    old = await post(env,'elevenlabs/jobs',{**env.a,'text':'Original narration'})
    finish_audio(env,old['id'])
    wx = await post(env,'whisperx/jobs',{**env.a,'source_id':old['id'],**OPTIONS}); finish_json(env,wx['id'])
    sub = await post(env,'srt/jobs',{**env.a,'source_id':wx['id'],'prompt':'Keep timings'}); finish_srt(env,sub['id'])
    await post(env,'workflow/import-scenes',{**env.a,'kind':'srt','id':sub['id']})
    newer = await post(env,'elevenlabs/jobs',{**env.a,'text':'A newer unrelated take'}); finish_audio(env,newer['id'])
    loaded = await post(env,'assembly/project-sources',env.a)
    assert scope.resource('asset',loaded['audio_id'])['sources'] == [scope.ref('elevenlabs',old['id'])]
    assert scope.resource('asset',loaded['srt_id'])['sources'] == [scope.ref('srt',sub['id'])]
    asset = env.va.asset(loaded['audio_id'])
    assert env.va.path(asset) == env.el.audio_path(old['id'], 'merged')
    assert asset['title'].startswith('ElevenLabs: ')
    again = await post(env,'assembly/project-sources',env.a)
    assert again['audio_id'] == loaded['audio_id']
    from agent.services import video_files
    files, errors = video_files.owned_files(**env.a)
    assert not any(item[0].startswith('audio/imports/') for item in files)
    assert not errors
    assert not env.va.jobs()


@pytest.mark.asyncio
async def test_no_storyboard_uses_only_scoped_imports_and_empty_video_stays_empty(env):
    subtitle = await env.va.import_upload('srt',Upload('Direct.srt',SRT.encode()),env.a)
    audio = await env.va.import_upload('audio',Upload('Direct.wav',wav(2)),env.a)
    picture = await env.va.import_upload('image',Upload('001.png',png((255,0,0))),env.a)
    loaded = await post(env,'assembly/project-sources',env.a)
    assert (loaded['srt_id'],loaded['audio_id']) == (subtitle['id'],audio['id'])
    assert [a['id'] for a in loaded['assets']] == [picture['id']]
    other = await crud.create_video(project_id=env.a['project_id'],title='Empty video')
    empty = await post(env,'assembly/project-sources',{**env.a,'video_id':other['id']})
    assert empty['srt_id'] is None and empty['audio_id'] is None and empty['assets'] == []


@pytest.mark.asyncio
async def test_scoped_render_resume_restart_and_legacy_path(env, tmp_path, monkeypatch):
    from agent.services import assembly_service as module
    await scene_image(env,tmp_path,monkeypatch)
    await env.wx.import_audio(Upload('Audio.wav',wav(2)),env.a)
    loaded = await post(env,'assembly/project-sources',env.a)
    body = {**env.a, 'srt_id':loaded['srt_id'],'audio_id':loaded['audio_id'],
        'image_ids':[a['id'] for a in loaded['assets']], 'mapping':loaded['mapping'],
        'title':'Final video','size':'720p','subtitles':'off'}
    queued = await post(env,'assembly/jobs',body); jid = queued['id']
    folder = Path(loaded['output_directory'])/jid
    real_command = module.command
    # Interrupt final mux after a completed scene has been checkpointed.
    real_probe = module.probe
    async def fail_final(path):
        if str(path).endswith('video.part.mp4'):
            raise ValueError('Simulated final verification interruption')
        return await real_probe(path)
    monkeypatch.setattr(module,'probe',fail_final)
    await env.va.process(jid)
    job = env.va.jobs()[0]
    assert job['state']=='FAILED' and job['saved_scenes']==1
    assert (folder/'clips/00000.mp4').is_file() and not (folder/'video.part.mp4').exists()
    assert not (env.va.output/jid).exists()
    # A restart, another selected video and title edits cannot move queued output.
    restarted = AssemblyService(env.va.store,env.va.output)
    await video_files.folders(**env.b)
    await crud.update_video(env.a['video_id'],title='Renamed after enqueue')
    monkeypatch.setattr(module,'probe',real_probe)
    async def no_scene_rerender(args, **kwargs):
        assert not str(args[-1]).endswith('00000.part.mp4'), 'Verified checkpoint must be reused'
        return await real_command(args,**kwargs)
    monkeypatch.setattr(module,'command',no_scene_rerender)
    restarted.resume(jid); await restarted.process(jid)
    assert restarted.jobs()[0]['state']=='COMPLETED'
    assert restarted.result_path(jid)==folder/'video.mp4'
    assert abs(float((await probe(restarted.result_path(jid)))['format']['duration'])-2)<.1
    synced = await video_files.sync_video(**env.a)
    assert not synced['warnings'] and not (folder.parent/(jid+'.mp4')).exists()
    assert (await env.client.get('/api/assembly/jobs/'+jid+'/video')).status_code==200
    # Pre-upgrade jobs keep their saved MP4 path.
    legacy = '00000000-0000-0000-0000-000000000001'
    old = env.va.output/legacy;old.mkdir(parents=True);(old/'video.mp4').write_bytes(b'legacy')
    with env.va.db() as db:
        db.execute('INSERT INTO assembly_jobs VALUES(?,?,?,?,?,?,?,?,?)',(legacy,'Old','COMPLETED','Completed',100,'{}',None,0,0))
        scope.record(db,'assembly',legacy,env.a)
    assert restarted.result_path(legacy)==old/'video.mp4'
