"""Real SQLite ownership/lineage with fixture outputs; no provider generation."""
import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import AsyncClient, ASGITransport

from agent.api import production, desktop, storyboard, elevenlabs, whisperx, srt, assembly
from agent.db import schema, crud
from agent.services import production_overview as overview, workflow_scope as scope
from agent.services.elevenlabs_bridge import ElevenLabsBridge
from agent.services.whisperx_service import WhisperXService
from agent.services.srt_service import SRTService
from agent.services.assembly_service import AssemblyService
from agent.services.concept_writer import Concept


@pytest_asyncio.fixture
async def env(tmp_path, monkeypatch):
    await schema.close_db()
    monkeypatch.setattr(schema, 'DB_PATH', tmp_path / 'main.db')
    monkeypatch.setattr(desktop, 'STORE', tmp_path / 'media.db')
    monkeypatch.setattr(desktop, 'ROOT', tmp_path / 'media')
    await schema.init_db()
    p = await crud.create_project(name='Project')
    a = await crud.create_video(project_id=p['id'], title='First video')
    b = await crud.create_video(project_id=p['id'], title='Second video')
    el = ElevenLabsBridge(tmp_path/'el.db', tmp_path/'el')
    wx = WhisperXService(tmp_path/'wx.db', tmp_path/'wx', el)
    sub = SRTService(tmp_path/'srt.db', tmp_path/'srt')
    va = AssemblyService(tmp_path/'assembly.db', tmp_path/'assembly')
    for module, name, value in [(elevenlabs, 'bridge', el), (whisperx, 'service', wx), (srt, 'service', sub), (assembly, 'service', va)]:
        monkeypatch.setattr(module, name, value)
    app = FastAPI()
    app.include_router(production.router, prefix='/api')
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        yield SimpleNamespace(client=client, el=el, wx=wx, srt=sub, va=va, pid=p['id'],
                              a={'project_id': p['id'], 'video_id': a['id']},
                              b={'project_id': p['id'], 'video_id': b['id']}, root=tmp_path)
    await schema.close_db()


def audio(env, ctx, state='COMPLETED'):
    job = env.el.enqueue('Test narration', context=ctx)
    folder = env.el.output/job['id']
    folder.mkdir(parents=True)
    (folder/'merged.wav').write_bytes(b'fixture audio')
    with env.el.db() as db:
        db.execute('UPDATE eleven_jobs SET state=?,merged_file=? WHERE id=?', (state, 'merged.wav', job['id']))
        db.execute("UPDATE eleven_chunks SET state='COMPLETED' WHERE job_id=?", (job['id'],))
    return job['id']


def resource(env, kind, rid, ctx, *, sources=()):
    if kind == 'whisperx':
        with env.wx.db() as db:
            db.execute('INSERT INTO wx_jobs(id,source_id,title,state,options,created) VALUES(?,?,?,?,?,?)', (rid, sources[0]['id'], rid, 'COMPLETED', '{}', time.time()))
            scope.record(db, kind, rid, ctx, sources)
        target = env.wx.output/rid/'transcript.json'
    elif kind == 'srt':
        with env.srt.db() as db:
            db.execute('INSERT INTO srt_jobs(id,source_id,title,prompt,model,state,created) VALUES(?,?,?,?,?,?,?)', (rid, sources[0]['id'], rid, 'prompt', 'auto', 'COMPLETED', time.time()))
            scope.record(db, kind, rid, ctx, sources)
        target = env.srt.output/rid/'subtitles.srt'
    else:
        raise AssertionError(kind)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text('{}' if kind == 'whisperx' else '1\n00:00:00,000 --> 00:00:03,000\nScene text\n')
    return target


async def scene(env, source_id=None):
    await storyboard.save_document(env.a['video_id'], storyboard.DocumentBody(script_text='', visual_style=''))
    result = await storyboard.import_segments(env.a['video_id'], storyboard.ImportBody(
        format='srt', content='1\n00:00:00,000 --> 00:00:03,000\nScene text\n'))
    if source_id:
        db = await schema.get_db()
        await db.execute('UPDATE document_source SET kind=?,source_id=? WHERE document_id=?', ('srt', source_id, result['document']['id']))
        await db.commit()
    return result


def stage(result, sid):
    return next(s for s in result['stages'] if s['id'] == sid)


@pytest.mark.asyncio
async def test_overview_isolates_each_video_and_checks_saved_file(env):
    aid = audio(env, env.a)
    result = (await env.client.get('/api/production/overview', params={'project_id':env.pid})).json()
    assert result['manual_stages'] is True
    a = next(v for v in result['videos'] if v['id'] == env.a['video_id'])
    b = next(v for v in result['videos'] if v['id'] == env.b['video_id'])
    assert stage(a, 'elevenlabs')['status'] == 'ready'
    assert stage(b, 'elevenlabs')['status'] == 'pending'
    assert a['next_stage'] == 'whisperx' and b['next_stage'] == 'elevenlabs'
    (env.el.output/aid/'merged.wav').unlink()
    a = (await overview.overview(**env.a))['videos'][0]
    assert stage(a, 'elevenlabs')['status'] == 'pending'


@pytest.mark.asyncio
async def test_current_srt_ancestry_does_not_use_a_different_narration(env):
    old = audio(env, env.a)
    resource(env, 'whisperx', 'wx-old', env.a, sources=[scope.ref('elevenlabs', old)])
    imported = env.srt.import_bytes(b'{"segments":[{"text":"scene"}]}', 'old.json', env.a, [scope.ref('whisperx', 'wx-old')])
    resource(env, 'srt', 'srt-old', env.a, sources=[scope.ref('json', imported['id'])])
    await scene(env, 'srt-old')
    new = audio(env, env.a)
    (env.el.output/old/'merged.wav').unlink()
    report = (await overview.overview(**env.a))['videos'][0]
    assert stage(report, 'elevenlabs')['ready'] == 0  # unrelated newer audio must not repair this chain
    sources = {s['id']: s for s in report['sources']['audio']}
    assert sources[old]['in_scene_lineage'] and not sources[new]['in_scene_lineage']
    assert stage(report, 'whisperx')['ready'] == 1
    assert stage(report, 'srt')['ready'] == 1


@pytest.mark.asyncio
async def test_prompt_and_media_readiness_respects_revision_and_prompt_kind(env):
    data = await scene(env)
    segment = data['segments'][0]
    await storyboard.save_concept(segment['id'], Concept(title='Scene', description='Text', image_prompt='Image prompt'))
    data = await storyboard.read_document(env.a['video_id'])
    segment = data['segments'][0]
    env_path = desktop.ROOT/'image.png'
    env_path.parent.mkdir(parents=True)
    env_path.write_bytes(b'fixture image')
    payload = {**env.a, 'kind':'image', 'document_id':data['document']['id'], 'segment_id':segment['id'],
               'concept_id':segment['active_concept']['id'], 'prompt':'Image prompt', 'start_ms':0, 'end_ms':3000}
    with desktop.connection() as db:
        db.execute("INSERT INTO jobs(id,payload,state,files,created) VALUES(?,?,'COMPLETED',?,?)", ('media', json.dumps(payload), json.dumps([str(env_path)]), time.time()))
    report = (await overview.overview(**env.a))['videos'][0]
    assert stage(report, 'images')['ready'] == 1
    assert stage(report, 'image_prompts')['ready'] == 1
    assert stage(report, 'video_prompts')['ready'] == 0
    # Adding the other prompt keeps existing image media current.
    await storyboard.save_concept(segment['id'], Concept(title='Scene', description='Text', image_prompt='Image prompt', video_prompt='Video prompt'))
    assert stage((await overview.overview(**env.a))['videos'][0], 'images')['ready'] == 1
    await storyboard.edit_segment(segment['id'], storyboard.SegmentBody(start_ms=0, end_ms=3000, text='Changed text'))
    report = (await overview.overview(**env.a))['videos'][0]
    assert stage(report, 'images')['ready'] == 0 and stage(report, 'image_prompts')['ready'] == 0


@pytest.mark.asyncio
async def test_recovery_never_resends_and_keeps_review_and_downloads_distinct(env):
    uncertain = env.el.enqueue('One', context=env.a)['id']
    downloadable = env.el.enqueue('Two', context=env.a)['id']
    other = env.el.enqueue('Other video', context=env.b)['id']
    with env.el.db() as db:
        db.execute("UPDATE eleven_jobs SET state='NEEDS_REVIEW'")
        db.execute("UPDATE eleven_chunks SET state='NEEDS_REVIEW'")
        db.execute('UPDATE eleven_chunks SET metadata=? WHERE job_id=?', (json.dumps({'nativeDownload':{'token':'fixture'}}), downloadable))
        before = [tuple(r) for r in db.execute('SELECT * FROM eleven_chunks ORDER BY job_id')]
    result = await overview.recovery(**env.a)
    assert result['automatic_resubmit'] is False
    rows = {j['id']: j for j in result['jobs']}
    assert rows[uncertain]['action'] == 'inspect'
    assert rows[downloadable]['action'] == 'recover_download'
    assert other not in rows
    assert result['counts']['needs_review'] == 2 and result['counts']['download_recoverable'] == 1
    with env.el.db() as db:
        assert before == [tuple(r) for r in db.execute('SELECT * FROM eleven_chunks ORDER BY job_id')]


@pytest.mark.asyncio
async def test_preflight_rejects_another_video_source_without_running_generation(env, monkeypatch):
    source = audio(env, env.b)
    monkeypatch.setattr(env.wx, 'check', AsyncMock(return_value={'ok':True, 'cuda_available':True}))
    monkeypatch.setattr(env.el, 'enqueue', lambda *args, **kwargs: pytest.fail('Must not enqueue during preflight'))
    report = (await env.client.post('/api/production/preflight', json={**env.a, 'stage':'whisperx', 'source_id':source})).json()
    assert report['blocked'] is True
    assert next(c for c in report['checks'] if c['id'] == 'source')['status'] == 'fail'
    assert not env.wx.jobs()


@pytest.mark.asyncio
async def test_missing_credit_and_missing_bound_tab_do_not_block_auto_prepared_tts(env, monkeypatch):
    env.el.peer = object()
    env.el.enabled = env.el.auto_prepare_tab = env.el.project_urls = True
    monkeypatch.setattr(overview.shutil, 'which', lambda name: '/usr/bin/' + name)
    result = await overview.preflight({**env.a, 'stage':'elevenlabs', 'text':'Japanese text'})
    assert result['blocked'] is False
    assert next(c for c in result['checks'] if c['id'] == 'credits')['status'] == 'warn'
    assert env.el.tab_id is None and env.el.jobs() == []


@pytest.mark.asyncio
async def test_outdated_extension_blocks_before_speech(env, monkeypatch):
    env.el.peer = object()
    env.el.enabled = env.el.auto_prepare_tab = True
    monkeypatch.setattr(overview.shutil, 'which', lambda name: '/usr/bin/' + name)
    result = await overview.preflight({**env.a, 'stage':'elevenlabs', 'text':'Test'})
    assert result['blocked']
    assert next(c for c in result['checks'] if c['id'] == 'extension_protocol')['status'] == 'fail'


@pytest.mark.asyncio
async def test_cli_preflight_does_not_require_or_contact_chatgpt(env, monkeypatch):
    from agent.services import chatgpt_gateway
    await scene(env)
    monkeypatch.setattr(overview.shutil, 'which', lambda name: '/usr/bin/' + name)
    monkeypatch.setattr(chatgpt_gateway, 'status', AsyncMock(side_effect=AssertionError('Unexpected gateway request')))
    result = await overview.preflight({**env.a, 'stage':'image_prompts', 'provider':'codex'})
    assert not result['blocked']
    assert any(c['id'] == 'cli_provider' for c in result['checks'])


@pytest.mark.asyncio
async def test_direct_media_checks_ownership_without_requiring_storyboard(env, monkeypatch):
    from agent.services import flow_client
    flow = SimpleNamespace(connected=True, _extensions={1:{'project_urls':True}}, generation_guard_status={})
    monkeypatch.setattr(flow_client, 'get_flow_client', lambda: flow)
    monkeypatch.setattr(desktop, 'paused', False)
    body = {**env.a, 'stage':'images', 'direct_jobs':[{**env.a, 'kind':'image', 'prompt':'One image'}]}
    result = await overview.preflight(body)
    assert not result['blocked']
    body['direct_jobs'][0]['video_id'] = env.b['video_id']
    assert (await overview.preflight(body))['blocked']


@pytest.mark.asyncio
async def test_scope_rejected_and_project_overview_without_videos_is_read_only(env):
    wrong = await env.client.get('/api/production/overview', params={'project_id':env.pid, 'video_id':'missing'})
    assert wrong.status_code == 409
    p = await crud.create_project(name='Empty')
    result = (await env.client.get('/api/production/overview', params={'project_id':p['id']})).json()
    assert result['videos'] == []
    db = await schema.get_db()
    assert (await (await db.execute('SELECT count(*) FROM video WHERE project_id=?', (p['id'],))).fetchone())[0] == 0


@pytest.mark.asyncio
async def test_completed_results_do_not_flood_recovery_but_missing_files_are_reported(env):
    jid = audio(env, env.a)
    report = await overview.recovery(**env.a)
    assert report['jobs'] == [] and report['retained_results'] == 1
    (env.el.output/jid/'merged.wav').unlink()
    report = await overview.recovery(**env.a)
    assert len(report['jobs']) == 1
    assert report['jobs'][0]['action'] == 'inspect' and 'missing' in report['jobs'][0]['message']


@pytest.mark.asyncio
async def test_explicit_cpu_selection_can_pass_when_cuda_default_is_unavailable(env, monkeypatch):
    source = audio(env, env.a)
    monkeypatch.setattr(env.wx, 'check', AsyncMock(return_value={'ok':True, 'cuda_available':False}))
    monkeypatch.setattr(overview.shutil, 'which', lambda name: '/usr/bin/' + name)
    body = {**env.a, 'stage':'whisperx', 'source_id':source}
    assert (await overview.preflight(body))['blocked']
    assert not (await overview.preflight({**body, 'device':'cpu'}))['blocked']


@pytest.mark.asyncio
async def test_media_preflight_requires_the_selected_prompt_kind(env, monkeypatch):
    from agent.services import flow_client
    flow = SimpleNamespace(connected=True, _extensions={1:{'project_urls':True}}, generation_guard_status={})
    monkeypatch.setattr(flow_client, 'get_flow_client', lambda: flow)
    monkeypatch.setattr(desktop, 'paused', False)
    data = await scene(env)
    sid = data['segments'][0]['id']
    await storyboard.save_concept(sid, Concept(title='Scene', description='Text', image_prompt='Image only'))
    body = {**env.a, 'segment_ids':[sid]}
    assert not (await overview.preflight({**body, 'stage':'images'}))['blocked']
    report = await overview.preflight({**body, 'stage':'videos'})
    assert report['blocked']
    assert next(c for c in report['checks'] if c['id'] == 'prompts')['status'] == 'fail'


@pytest.mark.asyncio
async def test_saved_srt_recommends_importing_scenes_not_skipping_to_render(env):
    aid = audio(env, env.a)
    resource(env, 'whisperx', 'words', env.a, sources=[scope.ref('elevenlabs', aid)])
    imported = env.srt.import_bytes(b'{"segments":[{"text":"scene"}]}', 'words.json', env.a, [scope.ref('whisperx', 'words')])
    resource(env, 'srt', 'subtitle', env.a, sources=[scope.ref('json', imported['id'])])
    report = (await overview.overview(**env.a))['videos'][0]
    assert report['next_stage'] == 'srt' and 'Import' in report['next_stage_reason']


@pytest.mark.asyncio
async def test_missing_srt_output_is_reported_without_crashing_recovery(env, monkeypatch):
    source = env.srt.import_bytes(b'{"segments":[{"text":"scene"}]}', 'words.json', env.a)
    path = resource(env, 'srt', 'missing-subtitle', env.a, sources=[scope.ref('json', source['id'])])
    path.unlink()
    assert stage((await overview.overview(**env.a))['videos'][0], 'srt')['ready'] == 0
    report = await overview.recovery(**env.a)
    assert report['jobs'][0]['action'] == 'inspect'
    # Also tolerate a missing result error instead of a returned-but-missing path.
    monkeypatch.setattr(env.srt, 'result_path', lambda *args, **kwargs: (_ for _ in ()).throw(ValueError('Missing output')))
    assert (await overview.recovery(**env.a))['jobs'][0]['action'] == 'inspect'


def test_recovery_only_resumes_known_remote_results_and_local_renders():
    base = {'id':'job', 'state':'FAILED'}
    assert overview.recovery_advice({**base, 'kind':'image', 'can_resume':True})['action'] == 'resume_download'
    assert overview.recovery_advice({**base, 'kind':'image', 'can_resume':False})['action'] == 'retry'
    assert overview.recovery_advice({**base, 'kind':'assembly', 'can_resume':True})['action'] == 'resume_render'
    assert overview.recovery_advice({**base, 'state':'NEEDS_REVIEW', 'kind':'image', 'can_resume':False})['action'] == 'inspect'
