import asyncio
import sqlite3
import pytest
import pytest_asyncio
from fastapi import FastAPI, HTTPException
from httpx import ASGITransport, AsyncClient
from agent.db import schema, crud
from agent.services.project_workspace import ensure
from agent.api import workflow, videos, projects


@pytest_asyncio.fixture
async def project(tmp_path, monkeypatch):
    await schema.close_db()
    monkeypatch.setattr(schema, 'DB_PATH', tmp_path/'projects.db')
    await schema.init_db()
    yield await crud.create_project(name='AI chip news')
    await schema.close_db()


@pytest.mark.asyncio
async def test_concurrent_selection_creates_exactly_one_internal_video(project):
    rows = await asyncio.gather(*(ensure(project['id']) for _ in range(20)))
    assert len({r['id'] for r in rows}) == 1
    assert all(r['title'] == project['name'] for r in rows)
    db = await schema.get_db()
    assert (await (await db.execute('SELECT COUNT(*) FROM video')).fetchone())[0] == 1
    context = await workflow.context(project['id'])
    assert context == {'project_id': project['id'], 'video_id': rows[0]['id']}


@pytest.mark.asyncio
async def test_existing_video_and_scenes_survive_and_title_tracks_project(project):
    video = await crud.create_video(project_id=project['id'], title='Old collection name')
    scene = await crud.create_scene(video_id=video['id'], display_order=0, prompt='Keep this prompt')
    result = await ensure(project['id'])
    assert result['id'] == video['id'] and result['title'] == project['name']
    assert (await crud.get_scene(scene['id']))['prompt'] == 'Keep this prompt'
    await crud.update_project(project['id'], name='New video title')
    assert (await crud.get_video(video['id']))['title'] == 'New video title'
    await schema.close_db()
    await schema.init_db()
    assert (await ensure(project['id']))['id'] == video['id']


@pytest.mark.asyncio
async def test_api_only_needs_project_and_legacy_create_is_idempotent(project):
    app = FastAPI()
    for api in [workflow, videos, projects]:
        app.include_router(api.router, prefix='/api')
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        result = await client.post('/api/workflow/project', json={'project_id': project['id']})
        assert result.status_code == 200
        first = result.json()
        assert first['protocol'] == 2 and first['title'] == project['name']
        for title in ['Different title', 'Another video']:
            result = await client.post('/api/videos', json={'project_id':project['id'], 'title':title})
            assert result.status_code == 200
            assert result.json()['id'] == first['video_id']
            assert result.json()['title'] == project['name']
        assert len((await client.get('/api/videos', params={'project_id':project['id']})).json()) == 1
        assert (await client.post('/api/workflow/project', json={'project_id':'missing'})).status_code == 404


@pytest.mark.asyncio
async def test_database_rejects_second_video_and_moving_into_occupied_project(project):
    first = await ensure(project['id'])
    db = await schema.get_db()
    with pytest.raises(sqlite3.IntegrityError, match='already has its video'):
        await db.execute('INSERT INTO video(id,project_id,title) VALUES(?,?,?)', ('duplicate',project['id'],'Duplicate'))
    await db.rollback()
    other = await crud.create_project(name='Another production')
    second = await ensure(other['id'])
    with pytest.raises(sqlite3.IntegrityError, match='already has its video'):
        await db.execute('UPDATE video SET project_id=? WHERE id=?', (project['id'],second['id']))
    await db.rollback()
    assert (await ensure(project['id']))['id'] == first['id']
    assert (await ensure(other['id']))['id'] == second['id']


@pytest.mark.asyncio
async def test_legacy_multi_video_migration_keeps_every_record_and_never_guesses(project):
    db = await schema.get_db()
    await db.execute('DROP TRIGGER one_video_per_project_insert')
    await db.commit()
    a = await crud.create_video(project_id=project['id'], title='Old A')
    b = await crud.create_video(project_id=project['id'], title='Old B')
    await schema.close_db()
    await schema.init_db()
    with pytest.raises(HTTPException) as error:
        await ensure(project['id'])
    assert error.value.status_code == 409 and '2 video collections' in error.value.detail
    assert (await crud.get_video(a['id']))['title'] == 'Old A'
    assert (await crud.get_video(b['id']))['title'] == 'Old B'
    await crud.update_project(project['id'], name='Renamed old project')
    assert (await crud.get_video(a['id']))['title'] == 'Old A'
