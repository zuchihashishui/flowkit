import asyncio
import json
import pytest
import pytest_asyncio
from fastapi import FastAPI, HTTPException
from httpx import ASGITransport, AsyncClient
from agent.db import schema, crud
from agent.services.project_workspace import ensure, select, create
from agent.models.video import VideoCreate
from agent.api import workflow, videos, projects, desktop


@pytest_asyncio.fixture
async def project(tmp_path, monkeypatch):
    await schema.close_db()
    monkeypatch.setattr(schema, 'DB_PATH', tmp_path/'projects.db')
    monkeypatch.setattr(desktop, 'STORE', tmp_path/'media.db')
    await schema.init_db()
    yield await crud.create_project(name='AI chip news')
    await schema.close_db()


@pytest.mark.asyncio
async def test_selection_is_read_only_and_multiple_creates_have_independent_ids(project):
    empty=await select(project['id'])
    assert empty['videos']==[] and empty['video_id'] is None and empty['protocol']==3
    with pytest.raises(HTTPException):await workflow.context(project['id'])
    rows=await asyncio.gather(*(create(VideoCreate(project_id=project['id'],title=f'Topic {n}')) for n in range(5)))
    assert len({r['id'] for r in rows})==5
    result=await select(project['id'])
    assert len(result['videos'])==5 and result['video_id'] is None
    with pytest.raises(HTTPException):await workflow.context(project['id'])
    chosen=await select(project['id'],rows[3]['id'])
    assert chosen['video_id']==rows[3]['id'] and chosen['title']=='Topic 3'
    assert await workflow.context(project['id'],rows[3]['id'])=={'project_id':project['id'],'video_id':rows[3]['id']}


@pytest.mark.asyncio
async def test_upgrade_removes_old_guards_without_changing_titles_scenes_or_ids(project):
    video=await crud.create_video(project_id=project['id'],title='Existing topic')
    scene=await crud.create_scene(video_id=video['id'],display_order=0,prompt='Keep this prompt')
    db=await schema.get_db()
    await db.executescript('''
      CREATE TRIGGER one_video_per_project_insert BEFORE INSERT ON video
      WHEN EXISTS(SELECT 1 FROM video WHERE project_id=NEW.project_id)
      BEGIN SELECT RAISE(ABORT,'already has its video'); END;
      CREATE TRIGGER one_video_per_project_move BEFORE UPDATE OF project_id ON video
      BEGIN SELECT RAISE(ABORT,'cannot move'); END;
      CREATE TRIGGER project_video_title AFTER UPDATE OF name ON project
      BEGIN UPDATE video SET title=NEW.name WHERE project_id=NEW.id; END;
    ''')
    await schema.close_db();await schema.init_db()
    assert (await ensure(project['id']))['id']==video['id']
    assert (await ensure(project['id']))['title']=='Existing topic'
    await crud.update_project(project['id'],name='Renamed channel')
    assert (await crud.get_video(video['id']))['title']=='Existing topic'
    assert (await crud.get_scene(scene['id']))['prompt']=='Keep this prompt'
    second=await create(VideoCreate(project_id=project['id'],title='Second topic'))
    await schema.close_db();await schema.init_db()
    assert {r['id'] for r in (await select(project['id']))['videos']}=={video['id'],second['id']}


@pytest.mark.asyncio
async def test_video_api_create_rename_selection_and_wrong_project(project):
    app=FastAPI()
    for api in [workflow,videos,projects]:app.include_router(api.router,prefix='/api')
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
        first=(await client.post('/api/videos',json={'project_id':project['id'],'title':' First topic '})).json()
        second=(await client.post('/api/videos',json={'project_id':project['id'],'title':'Second topic'})).json()
        assert first['id']!=second['id'] and first['title']=='First topic'
        result=await client.patch('/api/videos/'+first['id'],json={'title':'Updated topic'})
        assert result.status_code==200 and result.json()['title']=='Updated topic'
        await client.patch('/api/projects/'+project['id'],json={'name':'New project name'})
        assert (await client.get('/api/videos/'+second['id'])).json()['title']=='Second topic'
        assert len((await client.get('/api/videos',params={'project_id':project['id']})).json())==2
        body={'project_id':project['id'],'video_id':second['id']}
        assert (await client.post('/api/workflow/project',json=body)).json()['video_id']==second['id']
        other=await crud.create_project(name='Other')
        assert (await client.post('/api/workflow/project',json={**body,'project_id':other['id']})).status_code==409
        assert (await client.post('/api/videos',json={'project_id':'missing','title':'Topic'})).status_code==404
        assert (await client.post('/api/videos',json={'project_id':project['id'],'title':'   '})).status_code==422


@pytest.mark.asyncio
async def test_legacy_jobs_backfilled_before_second_video_and_never_guessed_after(project):
    first=await create(VideoCreate(project_id=project['id'],title='Original'))
    scene=await crud.create_scene(video_id=first['id'],display_order=0,prompt='Scene')
    with desktop.connection() as db:
        for jid,payload in [('single',{'project_id':project['id'],'prompt':'Single'}),('scene',{'project_id':project['id'],'scene_id':scene['id'],'prompt':'Scene'})]:
            db.execute("INSERT INTO jobs(id,payload,state,files,created) VALUES(?,?,'COMPLETED','[\"keep.wav\"]',1)",(jid,json.dumps(payload)))
    second=await create(VideoCreate(project_id=project['id'],title='Next'))
    for row in desktop.rows():
        assert json.loads(row['payload'])['video_id']==first['id']
        assert row['files']=='["keep.wav"]' and row['state']=='COMPLETED'
    with desktop.connection() as db:
        db.execute("INSERT INTO jobs(id,payload,state,created) VALUES('ambiguous',?,'COMPLETED',2)",(json.dumps({'project_id':project['id']}),))
    from agent.services.media_ownership import backfill
    await backfill()
    assert not json.loads(desktop.rows()[0]['payload']).get('video_id')
    assert len((await select(project['id']))['videos'])==2


@pytest.mark.asyncio
async def test_project_settings_shared_by_videos_isolated_and_revision_safe(project):
    from agent.services import project_settings as settings
    from pydantic import ValidationError
    a=project['id'];other=await crud.create_project(name='Other channel')
    await create(VideoCreate(project_id=a,title='Topic 1'))
    await create(VideoCreate(project_id=a,title='Topic 2'))
    app=FastAPI();app.include_router(projects.router,prefix='/api')
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
        path='/api/projects/'+a+'/settings'
        original=(await client.get(path)).json()
        saved=await client.put(path,json={**original,'image_prompt_url':'https://chatgpt.com/g/g-123-image-writer','elevenlabs_url':settings.DEFAULTS['elevenlabs_url']+'?voiceId=voice-a'})
        assert saved.status_code==200 and saved.json()['revision']==1
        assert (await client.put(path,json=original)).status_code==409
        assert (await settings.get(other['id']))['image_prompt_url']=='https://chatgpt.com/'
        await schema.close_db();await schema.init_db()
        assert (await settings.get(a))['image_prompt_url'].endswith('g-123-image-writer')
        invalid=['https://evil.example/g/g-123','http://chatgpt.com/','https://chatgpt.com/c/conversation','https://user@chatgpt.com/','https://chatgpt.com/g/g-a#fragment']
        for value in invalid:
            r=await client.put(path,json={**saved.json(),'image_prompt_url':value})
            assert r.status_code==422,value
        assert (await client.get('/api/projects/missing/settings')).status_code==404
    remote='11111111-2222-3333-4444-555555555555'
    for url in ['https://flow.google.com/project/'+remote,'https://labs.google/fx/tools/flow/project/'+remote]:
        assert settings.flow_project(settings.validate_url('google_flow_url',url),'local')==remote

@pytest.mark.asyncio
async def test_table_delete_only_allows_empty_records(project, monkeypatch):
    from agent.services import workflow_scope
    from agent.api import storyboard
    monkeypatch.setattr(workflow_scope, 'has_owned_resources', lambda **_: False)
    video=await crud.create_video(project_id=project['id'],title='Keep script')
    with pytest.raises(HTTPException) as error:
        await projects.delete(project['id'])
    assert error.value.status_code==409
    await storyboard.save_document(video['id'],storyboard.DocumentBody(script_text='Keep this text'))
    with pytest.raises(HTTPException) as error:
        await videos.delete(video['id'])
    assert error.value.status_code==409
    media_video=await crud.create_video(project_id=project['id'],title='Keep media')
    with desktop.connection() as db:
        db.execute("INSERT INTO jobs(id,payload,state,created) VALUES(?,?,?,?)",('j',json.dumps({'video_id':media_video['id']}),'COMPLETED',1))
    with pytest.raises(HTTPException) as error:
        await videos.delete(media_video['id'])
    assert error.value.status_code==409
    empty_project=await crud.create_project(name='Empty')
    empty_video=await crud.create_video(project_id=empty_project['id'],title='Empty')
    assert await videos.delete(empty_video['id'])=={'ok':True}
    assert await projects.delete(empty_project['id'])=={'ok':True}
    assert await crud.get_video(video['id']) and await crud.get_video(media_video['id'])
