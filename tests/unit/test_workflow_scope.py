"""Ownership and lineage against actual temporary service databases and HTTP APIs.

Generation results are fixtures: these tests never call a paid provider or model.
"""
import io
import json
import sqlite3
import struct
import wave
import zlib
from types import SimpleNamespace

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import AsyncClient, ASGITransport
from agent.api import assembly, elevenlabs, srt, whisperx, workflow, storyboard, desktop, projects, videos
from agent.db import schema, crud
from agent.services import workflow_scope as scope, srt_service, whisperx_service
from agent.services.elevenlabs_bridge import ElevenLabsBridge
from agent.services.assembly_service import AssemblyService

OPTIONS = {'model': 'large-v3', 'device': 'cuda', 'language': 'ja', 'batch_size': 8}
SRT = '1\n00:00:00,000 --> 00:00:02,000\n日本語です。\n'
TRANSCRIPT = json.dumps({'segments': [{'start': 0, 'end': 2, 'text': '日本語です。'}],
                         'word_segments': [{'word': '日', 'start': 0, 'end': .2}]}).encode()


@pytest_asyncio.fixture
async def env(tmp_path, monkeypatch):
    await schema.close_db()
    monkeypatch.setattr(schema, 'DB_PATH', tmp_path / 'main.db')
    monkeypatch.setattr(desktop, 'STORE', tmp_path / 'media.db')
    await schema.init_db()
    p = await crud.create_project(name='Project A')
    v = await crud.create_video(project_id=p['id'], title='Video A')
    p2 = await crud.create_project(name='Project B')
    v2 = await crud.create_video(project_id=p2['id'], title='Video B')
    el = ElevenLabsBridge(tmp_path/'el.db', tmp_path/'el')
    wx = whisperx_service.WhisperXService(tmp_path/'wx.db', tmp_path/'wx', el)
    sub = srt_service.SRTService(tmp_path/'srt.db', tmp_path/'srt')
    va = AssemblyService(tmp_path/'va.db', tmp_path/'va')
    for module, name, value in [(elevenlabs, 'bridge', el), (whisperx, 'service', wx),
                                (srt, 'service', sub), (assembly, 'service', va),
                                (srt_service, 'whisperx', wx), (srt_service, 'service', sub),
                                (whisperx_service, 'service', wx)]:
        monkeypatch.setattr(module, name, value)
    app = FastAPI()
    for api in [elevenlabs, whisperx, srt, assembly, workflow, storyboard, projects, videos]:
        app.include_router(api.router, prefix='/api')
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        yield SimpleNamespace(client=client, el=el, wx=wx, srt=sub, va=va,
                              a={'project_id': p['id'], 'video_id': v['id']},
                              b={'project_id': p2['id'], 'video_id': v2['id']},
                              other_project=p2['id'])
    await schema.close_db()


def finish_audio(env, jid):
    directory = env.el.output / jid
    directory.mkdir(parents=True)
    with wave.open(str(directory/'merged.wav'), 'wb') as audio:
        audio.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
        audio.writeframes(b'\0\0' * 32000)
    with env.el.db() as db:
        db.execute("UPDATE eleven_jobs SET state='COMPLETED',merged_file='merged.wav' WHERE id=?", (jid,))
        db.execute("UPDATE eleven_chunks SET state='COMPLETED' WHERE job_id=?", (jid,))


def finish_json(env, jid):
    folder = env.wx.output / jid
    folder.mkdir(parents=True)
    (folder/'transcript.json').write_bytes(TRANSCRIPT)
    env.wx.update(jid, state='COMPLETED', phase='COMPLETED')


def finish_srt(env, jid):
    folder = env.srt.output / jid
    folder.mkdir(parents=True, exist_ok=True)
    (folder/'subtitles.srt').write_text(SRT, encoding='utf-8')
    env.srt.update(jid, 'COMPLETED', cues=1)
    # Ownership tests use a completed, reviewed SRT fixture.
    env.srt.save_quality(jid, {'stage':'output', 'status':'REVIEW', 'issues':[]})
    env.srt.approve_quality(jid)


async def post(env, route, body):
    response = await env.client.post('/api/'+route, json=body)
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.asyncio
async def test_full_manual_chain_persists_exact_sources_and_preserves_scene_versions(env):
    el = await post(env, 'elevenlabs/jobs', {**env.a, 'text': '日本語です。', 'title': 'Narration v1'})
    finish_audio(env, el['id'])
    await env.wx.discover()
    assert not env.wx.jobs()  # completion never starts another stage
    wx = await post(env, 'whisperx/jobs', {**env.a, 'source_id': el['id'], **OPTIONS})
    assert scope.resource('whisperx', wx['id'])['sources'] == [scope.ref('elevenlabs', el['id'])]
    finish_json(env, wx['id'])
    assert not env.srt.jobs()
    job = await post(env, 'srt/jobs', {**env.a, 'source_id': wx['id'], 'prompt': 'Preserve Japanese and timings.'})
    saved_json = scope.resource('srt', job['id'])['sources'][0]
    assert scope.resource(**{'kind': saved_json['kind'], 'rid': saved_json['id']})['sources'] == [scope.ref('whisperx', wx['id'])]
    finish_srt(env, job['id'])
    assert not env.va.jobs()
    imported = await post(env, 'workflow/import-scenes', {**env.a, 'kind': 'srt', 'id': job['id']})
    segment = imported['segments'][0]
    assert (segment['text'], segment['start_ms'], segment['end_ms']) == ('日本語です。', 0, 2000)
    assert imported['document']['source']['source_id'] == job['id']
    assert not segment['concepts'] and segment['job'] is None  # explicit next stage
    second = await post(env, 'srt/jobs', {**env.a, 'source_id': wx['id'], 'prompt': 'Second version'})
    finish_srt(env, second['id'])
    response = await env.client.post('/api/workflow/import-scenes', json={**env.a, 'kind':'srt', 'id':second['id']})
    assert response.status_code == 409 and 'already has segments' in response.text
    restored = await storyboard.read_document(env.a['video_id'])
    assert restored['segments'][0]['id'] == segment['id']
    assert restored['document']['source']['source_id'] == job['id']
    assert env.srt.result_path(job['id']).read_text() == SRT
    library = (await env.client.get('/api/workflow/resources', params=env.a)).json()['resources']
    assert len([r for r in library if r['resource_kind'] == 'srt']) == 2
    assert next(r for r in library if r['id'] == job['id'])['scenes']['scene_count'] == 1
    await schema.close_db()
    await schema.init_db()
    assert (await storyboard.read_document(env.a['video_id']))['document']['source']['source_id'] == job['id']


@pytest.mark.asyncio
async def test_wrong_owner_rejected_and_scoped_lists_do_not_mix_versions(env):
    a = await post(env, 'elevenlabs/jobs', {**env.a, 'text':'Audio A'})
    b = await post(env, 'elevenlabs/jobs', {**env.b, 'text':'Audio B'})
    legacy = await post(env, 'elevenlabs/jobs', {'text':'Old audio'})
    finish_audio(env, a['id'])
    for ctx in [env.b, {**env.a, 'project_id':env.other_project}]:
        result = await env.client.post('/api/whisperx/jobs', json={**ctx, 'source_id':a['id'], **OPTIONS})
        assert result.status_code == 409
    assert not env.wx.jobs()
    for query, expected in [(env.a, a['id']), (env.b, b['id']), ({'unassigned':'true'}, legacy['id'])]:
        rows = (await env.client.get('/api/elevenlabs/jobs', params=query)).json()['jobs']
        assert [r['id'] for r in rows] == [expected]
    inherited = await post(env, 'whisperx/jobs', {'source_id': a['id'], **OPTIONS})
    assert scope.resource('whisperx', inherited['id'])['video_id'] == env.a['video_id']
    await env.client.post('/api/whisperx/jobs/'+inherited['id']+'/cancel')
    p = await env.client.post('/api/elevenlabs/jobs', json={'project_id':env.a['project_id'], 'text':'Incomplete scope'})
    assert p.status_code == 200
    assert scope.resource('elevenlabs', p.json()['id'])['video_id'] == env.a['video_id']


@pytest.mark.asyncio
async def test_import_picker_context_and_assembly_keep_upstream_ids(env):
    raw_audio = io.BytesIO()
    with wave.open(raw_audio, 'wb') as audio:
        audio.setparams((1,2,16000,0,'NONE','not compressed'))
        audio.writeframes(b'\0\0'*32000)
    response = await env.client.post('/api/whisperx/import', data=env.a, files={'file':('voice.wav', raw_audio.getvalue())})
    assert response.status_code == 200
    imported = response.json()
    wx = await post(env, 'whisperx/jobs', {**env.a, 'source_id':imported['id'], **OPTIONS})
    assert scope.resource('whisperx', wx['id'])['sources'] == [scope.ref('audio', imported['id'])]
    json_file = await env.client.post('/api/srt/import', data=env.a, files={'file':('words.json', TRANSCRIPT)})
    assert json_file.status_code == 200
    sub = await post(env, 'srt/jobs', {**env.a, 'source_id':json_file.json()['id'], 'prompt':'SRT'})
    finish_srt(env, sub['id'])
    srt_asset = await post(env, 'assembly/source', {**env.a, 'kind':'srt', 'source_id':sub['id']})
    audio_asset = await post(env, 'assembly/source', {**env.a, 'kind':'audio', 'source_id':imported['id']})
    assert scope.resource('asset', srt_asset['id'])['sources'] == [scope.ref('srt', sub['id'])]
    assert scope.resource('asset', audio_asset['id'])['sources'] == [scope.ref('audio', imported['id'])]
    assert env.va.path(env.va.asset(srt_asset['id'], 'srt')).read_text() == SRT
    mismatch = await env.client.post('/api/assembly/source', json={**env.b, 'kind':'audio', 'source_id':imported['id']})
    assert mismatch.status_code == 409
    assert len(env.va.assets()) == 2
    assert (await env.client.get('/api/assembly/status', params=env.b)).json()['assets'] == []
    def chunk(name, data):
        return struct.pack('!I', len(data)) + name + data + struct.pack('!I', zlib.crc32(name+data))
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', 16,16,8,2,0,0,0)) + chunk(b'IDAT', zlib.compress((b'\0'+b'\xff\0\0'*16)*16)) + chunk(b'IEND', b'')
    image = await env.client.post('/api/assembly/import/image', data=env.a, files={'file':('001.png', png)})
    assert image.status_code == 200, image.text
    body = {**env.a, 'audio_id':audio_asset['id'], 'srt_id':srt_asset['id'], 'image_ids':[image.json()['id']]}
    render = await post(env, 'assembly/jobs', body)
    record = scope.resource('assembly', render['id'])
    assert record['video_id'] == env.a['video_id']
    assert {r['id'] for r in record['sources']} == {audio_asset['id'], srt_asset['id'], image.json()['id']}
    rejected = await env.client.post('/api/assembly/jobs', json={**body, **env.b})
    assert rejected.status_code == 409 and len(env.va.jobs()) == 1
    # Optional clips are project-scoped inputs and remain in immutable render lineage.
    from agent.services.assembly_service import command
    clip_path = env.va.output/'scope-test.mp4'
    await command(['ffmpeg','-v','error','-y','-f','lavfi','-i','color=red:s=64x36:r=24:d=0.5',
                   '-c:v','libx264','-threads','1',clip_path])
    other_clip = await env.client.post('/api/assembly/import/video', data=env.b, files={'file':('001.mp4',clip_path.read_bytes())})
    assert other_clip.status_code == 200, other_clip.text
    mixed = {**body, 'visual_mode':'mixed', 'image_ids':[], 'video_ids':[other_clip.json()['id']]}
    for route in ['preview','jobs']:
        rejected = await env.client.post('/api/assembly/'+route, json=mixed)
        assert rejected.status_code == 409
    clip = await env.client.post('/api/assembly/import/video', data=env.a, files={'file':('001.mp4',clip_path.read_bytes())})
    assert clip.status_code == 200, clip.text
    mixed['video_ids'] = [clip.json()['id']]
    assert not (await post(env, 'assembly/preview', mixed))['missing']
    mixed_render = await post(env, 'assembly/jobs', mixed)
    refs = {r['id'] for r in scope.resource('assembly', mixed_render['id'])['sources']}
    assert refs == {audio_asset['id'],srt_asset['id'],clip.json()['id']}
    with env.va.db() as db:
        db.execute("DELETE FROM resource_scope WHERE kind='assembly' AND resource_id=?", (mixed_render['id'],))
    # Legacy lineage inference also includes video inputs after ownership migration.
    assert {r['id'] for r in scope.resource('assembly', mixed_render['id'])['sources']} == refs
    spoofed = await env.client.post('/api/storyboard/videos/'+env.a['video_id']+'/segments', json={
        'format':'srt', 'source_kind':'srt', 'source_id':sub['id'], 'content':SRT.replace('日本語です。', 'changed')})
    assert spoofed.status_code == 409 and 'does not match' in spoofed.text


@pytest.mark.asyncio
async def test_legacy_assignment_follows_entire_chain_and_never_guesses_owner(env):
    el = env.el.enqueue('Old narration')
    finish_audio(env, el['id'])
    wx = env.wx.enqueue(el['id'], OPTIONS)
    finish_json(env, wx['id'])
    # These tables did not exist in old installations.
    for service in [env.el, env.wx]:
        with service.db() as db:
            db.execute('DROP TABLE resource_scope')
    assert all(not r['video_id'] for r in scope.catalog())
    assert scope.resource('whisperx', wx['id'])['sources'] == [scope.ref('elevenlabs', el['id'])]
    body = {**env.a, 'kind':'whisperx', 'id':wx['id']}
    plan = await post(env, 'workflow/assignment-preview', body)
    assert {r['id'] for r in plan['resources']} == {el['id'], wx['id']}
    assert all(not r['video_id'] for r in scope.catalog())  # preview is read only
    assert (await post(env, 'workflow/assign', body))['assigned'] == 2
    assert all(r['video_id'] == env.a['video_id'] for r in scope.catalog())
    assert env.wx.result_path(wx['id']).read_bytes() == TRANSCRIPT
    assert (await post(env, 'workflow/assign', body))['assigned'] == 2  # repeat is safe
    response = await env.client.post('/api/workflow/assign', json={**body, **env.b})
    assert response.status_code == 409


@pytest.mark.asyncio
async def test_active_chain_cannot_be_assigned_and_cross_database_failure_rolls_back(env):
    el = env.el.enqueue('Legacy')
    finish_audio(env, el['id'])
    wx = env.wx.enqueue(el['id'], OPTIONS)
    with pytest.raises(ValueError, match='active jobs'):
        scope.assign('elevenlabs', el['id'], env.a)
    finish_json(env, wx['id'])
    with env.wx.db() as db:
        db.execute("CREATE TRIGGER fail_assign BEFORE UPDATE ON resource_scope BEGIN SELECT RAISE(ABORT, 'disk failure fixture'); END")
    with pytest.raises(sqlite3.IntegrityError, match='disk failure fixture'):
        scope.assign('elevenlabs', el['id'], env.a)
    assert not scope.resource('elevenlabs', el['id'])['video_id']
    assert not scope.resource('whisperx', wx['id'])['video_id']


@pytest.mark.asyncio
async def test_scope_failure_cannot_leave_unowned_new_job(env, monkeypatch):
    def failure(*args, **kwargs):
        raise sqlite3.IntegrityError('scope write failed')
    monkeypatch.setattr(scope, 'record', failure)
    with pytest.raises(sqlite3.IntegrityError):
        env.el.enqueue('Never persist half a job', context=env.a)
    assert env.el.jobs() == []
    with env.el.db() as db:
        assert db.execute('SELECT COUNT(*) FROM eleven_chunks').fetchone()[0] == 0


@pytest.mark.asyncio
async def test_old_auto_setting_migrates_once_and_video_scoped_audio_never_auto_starts(env):
    with env.wx.db() as db:
        db.execute('INSERT INTO wx_settings VALUES(1,?)', (json.dumps({**OPTIONS, 'auto':True}),))
    assert not env.wx.settings()['auto']
    env.wx.configure({'auto':True})  # explicit CLI compatibility opt-in
    el = env.el.enqueue('Scoped narration', context=env.a)
    finish_audio(env, el['id'])
    await env.wx.discover()
    assert env.wx.jobs() == []
    assert env.wx.settings()['auto'] is True


@pytest.mark.asyncio
async def test_other_videos_history_limit_cannot_hide_old_sources(env):
    source = env.srt.import_bytes(TRANSCRIPT, 'Old JSON', env.a)
    old = env.srt.enqueue(source['id'], 'Old SRT', 'auto', 1800, env.a)['id']
    finish_srt(env, old)
    with env.srt.db() as db:
        db.execute('UPDATE srt_jobs SET created=1 WHERE id=?', (old,))
        for index in range(501):
            rid = f'other-{index}'
            db.execute('INSERT INTO srt_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                       (rid, source['id'], 'Other video', 'prompt', 'auto', 1800, 'COMPLETED', None, 1, index+10, index+10))
            scope.record(db, 'srt', rid, env.b)
    assert old not in [j['id'] for j in env.srt.jobs()]
    result = (await env.client.get('/api/srt/status', params=env.a)).json()
    assert [j['id'] for j in result['jobs']] == [old]
    assert env.srt.result_path(old).read_text() == SRT


@pytest.mark.asyncio
async def test_delete_api_cannot_orphan_saved_video_sources(env):
    env.el.enqueue('Keep me', context=env.a)
    for route in ['/api/projects/'+env.a['project_id'], '/api/videos/'+env.a['video_id']]:
        response = await env.client.delete(route)
        assert response.status_code == 409 and 'preserve' in response.text
    assert await crud.get_video(env.a['video_id'])
    assert await crud.get_project(env.a['project_id'])
