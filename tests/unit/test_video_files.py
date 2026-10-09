import json
from pathlib import Path
import pytest
import pytest_asyncio
from fastapi import HTTPException
from agent.db import schema, crud
from agent.api import desktop, storyboard
from agent.services import video_files as vf, workflow_scope as scope
from agent.services.elevenlabs_bridge import ElevenLabsBridge


@pytest_asyncio.fixture
async def workspace(tmp_path, monkeypatch):
    await schema.close_db()
    monkeypatch.setattr(schema, 'DB_PATH', tmp_path / 'main.db')
    monkeypatch.setattr(vf, 'ROOT', tmp_path / 'output/projects')
    monkeypatch.setattr(desktop, 'STORE', tmp_path / 'desktop.db')
    monkeypatch.setattr(desktop, 'ROOT', tmp_path / 'output/desktop')
    await schema.init_db()
    project = await crud.create_project(name='Channel / 日本語')
    a = await crud.create_video(project_id=project['id'], title='Episode 1')
    b = await crud.create_video(project_id=project['id'], title='Episode 1')
    yield project, a, b
    await schema.close_db()


@pytest.mark.asyncio
async def test_folders_are_isolated_stable_and_validate_ownership(workspace):
    project, a, b = workspace
    first = await vf.folders(project['id'], a['id'])
    second = await vf.folders(project['id'], b['id'])
    assert first['directory'] != second['directory']
    assert 'Episode 1' in first['directory']
    await crud.update_video(a['id'], title='New title')
    await crud.update_project(project['id'], name='New channel')
    again = await vf.folders(project['id'], a['id'])
    assert first == again
    assert json.loads((Path(first['directory']) / 'video.json').read_text())['title'] == 'New title'
    assert all(Path(p).is_dir() for p in first['folders'].values())
    other = await crud.create_project(name='Other channel')
    with pytest.raises(HTTPException):
        await vf.folders(other['id'], a['id'])


@pytest.mark.asyncio
async def test_collect_legacy_exact_owners_and_skip_running_unassigned(workspace, tmp_path, monkeypatch):
    from agent.services.whisperx_service import WhisperXService
    from agent.services.srt_service import SRTService
    project, a, b = workspace
    el = ElevenLabsBridge(store=tmp_path/'el.db', output=tmp_path/'el')
    wx = WhisperXService(store=tmp_path/'wx.db', output=tmp_path/'wx')
    sr = SRTService(store=tmp_path/'srt.db', output=tmp_path/'srt')
    monkeypatch.setattr(scope, 'providers', lambda: {'elevenlabs':(el,'eleven_jobs'), 'whisperx':(wx,'wx_jobs'), 'srt':(sr,'srt_jobs')})
    for rid, owner, state in [('saved-a',a,'COMPLETED'), ('saved-b',b,'COMPLETED'), ('running',a,'RUNNING'), ('unassigned',None,'COMPLETED')]:
        with wx.db() as db:
            db.execute('INSERT INTO wx_jobs(id,source_id,title,state,options) VALUES(?,?,?,?,?)', (rid,'source','Test',state,'{}'))
            if owner: scope.record(db,'whisperx',rid,{'project_id':project['id'],'video_id':owner['id']})
        directory=wx.output/rid;directory.mkdir(parents=True)
        (directory/'transcript.json').write_text('{"ok":true}')
        (directory/'transcript.json.part').write_text('partial')
    job=el.enqueue('Narration text',context={'project_id':project['id'],'video_id':a['id']})
    with el.db() as db:db.execute("UPDATE eleven_jobs SET state='COMPLETED' WHERE id=?",(job['id'],))
    (el.output/job['id']).mkdir(parents=True)
    (el.output/job['id']/'merged.mp3').write_bytes(b'audio')
    first=await vf.sync_video(project['id'],a['id'])
    folder=Path(first['directory'])
    assert (folder/'whisperx/saved-a/transcript.json').is_file()
    assert (folder/'elevenlabs'/job['id']/'merged.mp3').read_bytes()==b'audio'
    assert (folder/'elevenlabs'/job['id']/'source.txt').read_text()=='Narration text'
    assert not (folder/'whisperx/saved-b').exists()
    assert not (folder/'whisperx/running').exists()
    assert not (folder/'whisperx/unassigned').exists()
    assert not list(folder.rglob('*.part'))
    original=(wx.output/'saved-a/transcript.json').read_bytes()
    target=folder/'whisperx/saved-a/transcript.json';mtime=target.stat().st_mtime_ns
    await vf.sync_video(project['id'],a['id'])
    assert target.stat().st_mtime_ns==mtime
    assert target.read_bytes()==original==(wx.output/'saved-a/transcript.json').read_bytes()


@pytest.mark.asyncio
async def test_scene_mapping_and_cleanup_preserve_originals_and_user_files(workspace, tmp_path, monkeypatch):
    project,a,b=workspace
    monkeypatch.setattr(scope,'providers',lambda:{})
    await storyboard.save_document(a['id'],storyboard.DocumentBody())
    await storyboard.import_segments(a['id'],storyboard.ImportBody(format='srt',content='101\n00:00:00,000 --> 00:00:01,000\n日本語\n'))
    data=await storyboard.read_document(a['id']);scene=data['segments'][0];doc=data['document']
    db=await schema.get_db()
    await db.execute('INSERT INTO scene_concept VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',('concept',scene['id'],1,scene['revision'],doc['revision'],'Title','Desc','image prompt','video prompt','manual','',1))
    await db.execute('UPDATE script_segment SET active_concept_id=? WHERE id=?',('concept',scene['id']));await db.commit()
    desktop.ROOT.mkdir(parents=True)
    jpg=desktop.ROOT/'original.jpg';jpg.write_bytes(b'jpg')
    payload={'project_id':project['id'],'video_id':a['id'],'document_id':doc['id'],'segment_id':scene['id'],'concept_id':'concept','kind':'image','prompt':'image prompt','start_ms':0,'end_ms':1000}
    with desktop.connection() as store:
        store.execute("INSERT INTO jobs(id,payload,state,files,created) VALUES(?,?,'COMPLETED',?,1)",('job',json.dumps(payload),json.dumps([str(jpg)])))
    result=await vf.sync_video(project['id'],a['id']);folder=Path(result['directory'])
    assert not result['warnings']
    assert (folder/'images/001.jpg').read_bytes()==b'jpg'
    assert (folder/'prompts/image/001.txt').read_text()=='image prompt'
    assert '101\n' in (folder/'srt/source.srt').read_text()
    assert '1\n' in (folder/'srt/scenes.srt').read_text()
    assert scene['id'] in (folder/'scenes.csv').read_text()
    (folder/'images/my-notes.txt').write_text('keep')
    png=desktop.ROOT/'new.png';png.write_bytes(b'png')
    with desktop.connection() as store:
        store.execute("INSERT INTO jobs(id,payload,state,files,created) VALUES(?,?,'COMPLETED',?,2)",('new-job',json.dumps(payload),json.dumps([str(png)])))
    await vf.sync_video(project['id'],a['id'])
    assert not (folder/'images/001.jpg').exists()
    assert (folder/'images/001.png').read_bytes()==b'png'
    assert jpg.read_bytes()==b'jpg' and (folder/'images/my-notes.txt').read_text()=='keep'
    await db.execute('UPDATE script_segment SET revision=revision+1 WHERE id=?',(scene['id'],));await db.commit()
    await vf.sync_video(project['id'],a['id'])
    assert not (folder/'images/001.png').exists()
    assert not (folder/'prompts/image/001.txt').exists()


def test_reject_copy_escape_and_destination_symlink(tmp_path):
    root=tmp_path/'workspace';root.mkdir();source=tmp_path/'source';source.mkdir()
    original=source/'a.mp3';original.write_bytes(b'audio')
    with pytest.raises(ValueError):vf.copy(root,'../outside.mp3',original,source)
    (root/'audio').symlink_to(source,target_is_directory=True)
    with pytest.raises(ValueError):vf.copy(root,'audio/a.mp3',original,source)
    with pytest.raises(ValueError):vf.copy(root,'b.mp3',original,root)
    assert original.read_bytes()==b'audio'

@pytest.mark.asyncio
async def test_owned_stage_files_write_inside_video_and_legacy_stays_readable(workspace, tmp_path):
    from agent.services import output_paths
    from agent.services.whisperx_service import WhisperXService
    from agent.services.srt_service import SRTService
    project, a, b = workspace
    ctx = {'project_id': project['id'], 'video_id': a['id']}
    folder = Path((await vf.folders(**ctx))['directory'])
    el = ElevenLabsBridge(store=tmp_path/'el-new.db', output=tmp_path/'legacy-el')
    job = el.enqueue('Narration', context=ctx)
    audio = output_paths.job_directory(el, 'elevenlabs', job['id'])/'merged.mp3'
    audio.parent.mkdir(parents=True, exist_ok=True);audio.write_bytes(b'audio')
    with el.db() as db:
        db.execute('UPDATE eleven_jobs SET merged_file=? WHERE id=?', ('merged.mp3',job['id']))
    assert el.audio_path(job['id'], 'merged') == audio
    assert audio.is_relative_to(folder/'elevenlabs')
    assert not (el.output/job['id']).exists()
    wx = WhisperXService(store=tmp_path/'wx-new.db', output=tmp_path/'legacy-wx')
    with wx.db() as db:
        db.execute("INSERT INTO wx_jobs(id,source_id,title,state,options) VALUES('new','source','Test','COMPLETED','{}')")
        scope.record(db, 'whisperx', 'new', ctx)
    transcript=output_paths.job_directory(wx,'whisperx','new')/'transcript.json'
    transcript.parent.mkdir(parents=True,exist_ok=True);transcript.write_text('{"segments":[]}')
    assert wx.result_path('new') == transcript
    assert transcript.is_relative_to(folder/'whisperx')
    sr=SRTService(store=tmp_path/'srt-new.db',output=tmp_path/'legacy-srt')
    imported=sr.import_bytes(b'{"text":"Hello"}', 'source.json', ctx)
    assert sr.source_path(imported['id']).is_relative_to(folder/'srt/imports')
    assert sr.source_data(imported['id']) == b'{"text":"Hello"}'
    with sr.db() as db:
        db.execute("INSERT INTO srt_jobs(id,state) VALUES('new','COMPLETED')")
        scope.record(db,'srt','new',ctx)
    subtitle=output_paths.job_directory(sr,'srt','new')/'subtitles.srt'
    subtitle.parent.mkdir(parents=True,exist_ok=True);subtitle.write_text('saved')
    assert sr.result_path('new') == subtitle
    # Existing files retain stable paths even after the upgrade.
    old=el.output/'old';old.mkdir(parents=True)
    with el.db() as db: scope.record(db,'elevenlabs','old',ctx)
    assert output_paths.job_directory(el,'elevenlabs','old') == old
    other=output_paths.video_directory({'project_id':project['id'],'video_id':b['id']})
    assert other != folder
    with pytest.raises(ValueError):
        output_paths.video_directory({'project_id':'wrong','video_id':a['id']})

@pytest.mark.asyncio
async def test_prompt_and_scene_media_paths_share_video_root(workspace):
    import uuid
    from agent.services import output_paths, prompt_batch
    project,a,b=workspace
    ctx={'project_id':project['id'],'video_id':a['id']}
    root=output_paths.video_directory(ctx)
    run=str(uuid.uuid4())
    assert prompt_batch.session_folder(run,ctx) == root/'text_prompts'/run
    for kind in ('image','video'):
        path=output_paths.owned_path(desktop.ROOT/run,ctx,f'scene_board/{kind}/{run}')
        assert path == root/'scene_board'/kind/run
        assert output_paths.allowed(path,desktop.ROOT)
    await crud.update_video(a['id'],title='Renamed')
    assert output_paths.video_directory(ctx)==root
