import json
from pathlib import Path

import pytest
import pytest_asyncio

from tests.unit.test_workflow_scope import env, post, finish_audio, finish_json, finish_srt, OPTIONS
from agent.api import desktop, storyboard
from agent.db import crud, schema
from agent.services import workflow_scope as scope, video_files, prompt_batch


@pytest_asyncio.fixture
async def populated(env, tmp_path, monkeypatch):
    from agent import config
    monkeypatch.setattr(config, 'OUTPUT_DIR', tmp_path/'output')
    monkeypatch.setattr(config, 'BASE_DIR', tmp_path)
    monkeypatch.setattr(desktop, 'ROOT', tmp_path/'media')
    monkeypatch.setattr(storyboard, 'AUDIO_DIR', tmp_path/'audio')
    monkeypatch.setattr(prompt_batch, 'ARCHIVE_DIR', tmp_path/'prompts')
    # A full scoped source chain, plus a sibling video and an unrelated project.
    el = await post(env, 'elevenlabs/jobs', {**env.a, 'text': 'Narration'})
    finish_audio(env, el['id'])
    wx = await post(env, 'whisperx/jobs', {**env.a, 'source_id': el['id'], **OPTIONS})
    finish_json(env, wx['id'])
    srt = await post(env, 'srt/jobs', {**env.a, 'source_id': wx['id'], 'prompt': 'Preserve timings.'})
    finish_srt(env, srt['id'])
    data = await post(env, 'workflow/import-scenes', {**env.a, 'kind': 'srt', 'id': srt['id']})
    env.sibling = await crud.create_video(project_id=env.a['project_id'], title='Keep sibling')
    env.paths = await video_files.folders(**env.a)
    env.sibling_paths = await video_files.folders(env.a['project_id'], env.sibling['id'])
    env.other_paths = await video_files.folders(**env.b)
    Path(env.paths['directory'], 'exports', 'movie.mp4').write_bytes(b'movie')
    Path(env.sibling_paths['directory'], 'images', '001.png').write_bytes(b'sibling')
    Path(env.other_paths['directory'], 'images', '001.png').write_bytes(b'other')
    env.media = desktop.ROOT/'media-a'
    env.media.mkdir(parents=True)
    (env.media/'image.png').write_bytes(b'image')
    with desktop.connection() as db:
        db.execute("INSERT INTO jobs(id,payload,state,files,created) VALUES(?,?,'COMPLETED',?,1)",
                   ('media-a', json.dumps(env.a), json.dumps([str(env.media/'image.png')])))
    env.run = prompt_batch.ARCHIVE_DIR/'run-a'
    env.run.mkdir(parents=True)
    (env.run/'prompts.zip').write_bytes(b'zip')
    db = await schema.get_db()
    await db.execute("INSERT INTO concept_job(id,segment_id,state,payload,created) VALUES('concept-a',?,'COMPLETED',?,1)",
                     (data['segments'][0]['id'], json.dumps({**env.a, 'text_output_id':'run-a'})))
    await db.commit()
    # Include renderer assets, output-location metadata, quality/settings and chunks.
    with env.va.db() as db:
        for aid, kind in [('audio-a','audio'),('srt-a','srt'),('image-a','image')]:
            db.execute('INSERT INTO assembly_assets VALUES(?,?,?,?,?,1)', (aid,kind,aid,aid+'.dat','{}'))
            scope.record(db,'asset',aid,env.a)
        db.execute("INSERT INTO assembly_jobs(id,title,state,plan,created) VALUES('render-a','Render','COMPLETED',?,1)",
                   (json.dumps({'audio_id':'audio-a','srt_id':'srt-a','image_ids':['image-a']}),))
        scope.record(db,'assembly','render-a',env.a)
        scope.save_settings(db,'assembly','render-a',{'test':True})
    env.chain = el, wx, srt
    return env


@pytest.mark.asyncio
@pytest.mark.parametrize('kind', ['videos','projects'])
async def test_cascade_removes_hierarchy_history_and_managed_files(populated, kind):
    env = populated
    target = env.a['video_id' if kind == 'videos' else 'project_id']
    response = await env.client.delete('/api/'+kind+'/'+target+'?cascade=true')
    assert response.status_code == 200, response.text
    assert response.json() == {'ok':True, 'cleanup_pending':[]}
    assert not await crud.get_video(env.a['video_id'])
    assert not Path(env.paths['directory']).exists()
    assert not env.media.exists() and not env.run.exists()
    assert not scope.catalog()
    assert not desktop.rows()
    for service, table in [(env.el,'eleven_chunks'),(env.srt,'srt_quality'),(env.va,'job_settings')]:
        with service.db() as db:
            assert not db.execute('SELECT * FROM '+table).fetchall()
    assert bool(await crud.get_project(env.a['project_id'])) == (kind == 'videos')
    assert bool(await crud.get_video(env.sibling['id'])) == (kind == 'videos')
    assert Path(env.sibling_paths['directory']).exists() == (kind == 'videos')
    assert await crud.get_video(env.b['video_id'])
    assert Path(env.other_paths['directory'],'images','001.png').read_bytes() == b'other'
    db = await schema.get_db()
    assert not await (await db.execute('PRAGMA foreign_key_check')).fetchall()
    for table in ['script_document','script_segment','concept_job']:
        assert not await (await db.execute('SELECT * FROM '+table)).fetchall()


@pytest.mark.asyncio
@pytest.mark.parametrize('state', ['QUEUED','RUNNING','SUBMITTING','DOWNLOADING','CANCELLING'])
async def test_active_jobs_block_without_removing_any_files_or_records(populated, state):
    env = populated
    with desktop.connection() as db:
        db.execute('UPDATE jobs SET state=?', (state,))
    response = await env.client.delete('/api/projects/'+env.a['project_id']+'?cascade=true')
    assert response.status_code == 409 and state in response.text
    assert await crud.get_video(env.a['video_id'])
    assert env.media.exists() and env.run.exists() and Path(env.paths['directory']).exists()
    assert scope.catalog()


@pytest.mark.asyncio
async def test_external_source_dependency_blocks_whole_delete(populated):
    env = populated
    with env.wx.db() as db:
        db.execute("INSERT INTO wx_jobs(id,source_id,title,state,options,created) VALUES('external',?,'Legacy','COMPLETED','{}',1)", (env.chain[0]['id'],))
    response = await env.client.delete('/api/videos/'+env.a['video_id']+'?cascade=true')
    assert response.status_code == 409 and 'outside' in response.text
    assert await crud.get_video(env.a['video_id']) and env.media.exists()


@pytest.mark.asyncio
async def test_database_failure_restores_staged_files_and_all_service_records(populated):
    env = populated
    db = await schema.get_db()
    await db.execute("CREATE TRIGGER fail_delete BEFORE DELETE ON video BEGIN SELECT RAISE(ABORT,'test disk failure'); END")
    await db.commit()
    import sqlite3
    with pytest.raises(sqlite3.IntegrityError, match='test disk failure'):
        await env.client.delete('/api/videos/'+env.a['video_id']+'?cascade=true')
    assert await crud.get_video(env.a['video_id'])
    assert (env.media/'image.png').read_bytes() == b'image'
    assert (env.run/'prompts.zip').read_bytes() == b'zip'
    assert Path(env.paths['directory'],'exports','movie.mp4').read_bytes() == b'movie'
    assert scope.resource('assembly','render-a') and desktop.rows()


@pytest.mark.asyncio
async def test_locked_file_rolls_back_before_database_deletion(populated, monkeypatch):
    env = populated
    original = Path.rename
    count = 0
    def rename(path, target):
        nonlocal count
        count += 1
        if count == 2:
            raise PermissionError('File is open in another application')
        return original(path,target)
    monkeypatch.setattr(Path, 'rename', rename)
    response = await env.client.delete('/api/videos/'+env.a['video_id']+'?cascade=true')
    assert response.status_code == 409 and 'Close any application' in response.text
    assert await crud.get_video(env.a['video_id']) and env.media.exists() and env.run.exists()


@pytest.mark.asyncio
async def test_foreign_output_path_is_not_deleted(populated):
    env = populated
    from agent.services import output_paths
    with env.va.db() as db:
        output_paths.remember(db,'asset','image-a',Path(env.other_paths['directory'],'images','001.png'))
    response = await env.client.delete('/api/videos/'+env.a['video_id']+'?cascade=true')
    assert response.status_code == 409 and 'different project/video' in response.text
    assert Path(env.other_paths['directory'],'images','001.png').read_bytes() == b'other'
    assert await crud.get_video(env.a['video_id'])


@pytest.mark.asyncio
async def test_restart_restores_files_from_uncommitted_deletion(populated):
    import uuid
    from agent.services import workspace_delete_files as files
    env = populated
    token = uuid.uuid4().hex
    files.stage([env.media, env.run], token)
    assert not env.media.exists()
    files.recover()
    assert (env.media/'image.png').read_bytes() == b'image'
    assert env.run.exists() and not files.journal_path(token).exists()
    assert await crud.get_video(env.a['video_id'])


@pytest.mark.asyncio
async def test_locked_cleanup_is_retried_on_restart(populated, monkeypatch):
    from agent.services import workspace_delete_files as files
    env = populated
    original = files.shutil.rmtree
    def locked(path):
        raise PermissionError('Still open')
    monkeypatch.setattr(files.shutil, 'rmtree', locked)
    response = await env.client.delete('/api/videos/'+env.a['video_id']+'?cascade=true')
    assert response.status_code == 200
    pending = response.json()['cleanup_pending']
    assert pending and all(Path(path).exists() for path in pending)
    assert not await crud.get_video(env.a['video_id'])
    monkeypatch.setattr(files.shutil, 'rmtree', original)
    files.recover()
    assert all(not Path(path).exists() for path in pending)
    db = await schema.get_db()
    assert not await (await db.execute('SELECT * FROM workspace_deletion')).fetchall()


@pytest.mark.asyncio
async def test_completed_narration_still_merging_cannot_be_deleted(populated):
    env = populated
    env.el.merging.add(env.chain[0]['id'])
    response = await env.client.delete('/api/projects/'+env.a['project_id']+'?cascade=true')
    assert response.status_code == 409 and 'still processing' in response.text
    assert await crud.get_project(env.a['project_id']) and env.media.exists()
