"""Inheritance and frozen jobs use temporary databases; no provider calls."""
import io
import wave
import pytest
import pytest_asyncio
from pydantic import ValidationError
from fastapi import FastAPI, HTTPException
from httpx import AsyncClient, ASGITransport
from agent.db import schema, crud
from agent.api import projects, videos, elevenlabs, whisperx
from agent.services import project_settings as ps, production_settings as settings, workflow_scope as scope
from agent.services.elevenlabs_bridge import ElevenLabsBridge
from agent.services.whisperx_service import WhisperXService


@pytest_asyncio.fixture
async def env(tmp_path, monkeypatch):
    await schema.close_db()
    monkeypatch.setattr(schema, 'DB_PATH', tmp_path/'main.db')
    await schema.init_db()
    a = await crud.create_project(name='Channel A')
    b = await crud.create_project(name='Channel B')
    va = await crud.create_video(project_id=a['id'], title='First topic')
    va2 = await crud.create_video(project_id=a['id'], title='Next topic')
    vb = await crud.create_video(project_id=b['id'], title='Other channel')
    el = ElevenLabsBridge(tmp_path/'el.db', tmp_path/'el')
    wx = WhisperXService(tmp_path/'wx.db', tmp_path/'wx', el)
    monkeypatch.setattr(elevenlabs, 'bridge', el)
    monkeypatch.setattr(whisperx, 'service', wx)
    app = FastAPI()
    for module in [projects, videos, elevenlabs, whisperx]:
        app.include_router(module.router, prefix='/api')
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        yield {'client': client, 'a': a['id'], 'b': b['id'], 'va': va['id'], 'va2': va2['id'], 'vb': vb['id'], 'el': el, 'wx': wx}
    await schema.close_db()


async def project_defaults(pid, **sections):
    current = await ps.get(pid)
    current['production'] = settings.merge(current['production'], sections)
    return await ps.save(pid, ps.SettingsBody(**current))


@pytest.mark.asyncio
async def test_inherit_override_reset_revision_and_project_isolation(env):
    initial = await settings.get(env['va'])
    assert initial['effective']['tts']['max_chunk_characters'] == 3000
    assert initial['effective']['assembly']['image_motion'] == 'none'
    assert initial['effective']['whisperx']['device'] == 'cuda'
    await project_defaults(env['a'], tts={'max_chunk_characters': 1500, 'expected_voice': 'Minato'}, assembly={'image_motion': 'zoom_in'})
    assert (await settings.get(env['va2']))['effective']['tts']['max_chunk_characters'] == 1500
    assert (await settings.get(env['vb']))['effective']['tts']['max_chunk_characters'] == 3000
    own = await settings.save(env['va'], settings.VideoSettingsBody(overrides={'tts': {'max_chunk_characters': 1200}}))
    assert own['overrides'] == {'tts': {'max_chunk_characters': 1200}}
    assert own['effective']['tts']['expected_voice'] == 'Minato'
    await project_defaults(env['a'], tts={'max_chunk_characters': 2500, 'expected_voice': 'New voice'})
    resolved = await settings.get(env['va'])
    assert resolved['effective']['tts'] == {'model': 'Eleven v4', 'expected_voice': 'New voice', 'max_chunk_characters': 1200}
    assert (await settings.get(env['va2']))['effective']['tts']['max_chunk_characters'] == 2500
    with pytest.raises(HTTPException) as conflict:
        await settings.save(env['va'], settings.VideoSettingsBody(revision=0))
    assert conflict.value.status_code == 409
    reset = await settings.save(env['va'], settings.VideoSettingsBody(revision=own['revision'], overrides={}))
    assert reset['effective']['tts']['max_chunk_characters'] == 2500
    await schema.close_db(); await schema.init_db()
    assert (await settings.get(env['va']))['effective'] == reset['effective']


@pytest.mark.asyncio
async def test_url_only_old_client_preserves_production_and_snapshot_checks_ownership(env):
    saved = await project_defaults(env['a'], tts={'max_chunk_characters': 1100})
    legacy = {key: value for key, value in saved.items() if key != 'production'}
    legacy['image_prompt_url'] = 'https://chatgpt.com/g/g-new-image'
    result = await ps.save(env['a'], ps.SettingsBody(**legacy))
    assert result['production']['tts']['max_chunk_characters'] == 1100
    snapshot = await ps.snapshot({'project_id': env['a'], 'video_id': env['va']})
    assert snapshot['production']['tts']['max_chunk_characters'] == 1100
    snapshot['production']['tts']['model'] = 'Changed locally'
    assert (await settings.get(env['va']))['effective']['tts']['model'] == 'Eleven v4'
    with pytest.raises(HTTPException) as wrong:
        await ps.snapshot({'project_id': env['a'], 'video_id': env['vb']})
    assert wrong.value.status_code == 409


@pytest.mark.asyncio
async def test_video_settings_http_validation_conflicts_and_missing(env):
    client = env['client']; path = '/api/videos/'+env['va']+'/settings'
    first = await client.get(path)
    assert first.status_code == 200 and first.json()['revision'] == 0
    saved = await client.put(path, json={'revision': 0, 'overrides': {'whisperx': {'language': 'ja'}}})
    assert saved.status_code == 200 and saved.json()['effective']['whisperx']['language'] == 'ja'
    assert (await client.put(path, json={'revision': 0, 'overrides': {}})).status_code == 409
    for invalid in [{'tts': {'max_chunk_characters': 3001}}, {'tts': {'max_chunk_characters': True}},
                    {'whisperx': {'device': 'GPU'}}, {'whisperx': {'language': 'Japanese'}},
                    {'assembly': {'image_motion': 'bounce'}}, {'assembly': {'fps': 0}},
                    {'tts': {'mode1': 'misspelled'}}, {'other': {}}, {'tts': None}]:
        assert (await client.put(path, json={'revision': 1, 'overrides': invalid})).status_code == 422
    assert (await client.get('/api/videos/missing/settings')).status_code == 404
    assert (await client.put('/api/videos/missing/settings', json={'overrides': {}})).status_code == 404


@pytest.mark.asyncio
async def test_tts_job_freezes_defaults_and_explicit_options_win(env):
    await project_defaults(env['a'], tts={'max_chunk_characters': 1000, 'model': 'Eleven v3', 'expected_voice': 'Minato'})
    ctx = {'project_id': env['a'], 'video_id': env['va']}
    first = await env['client'].post('/api/elevenlabs/jobs', json={**ctx, 'text': '日'*2400})
    assert first.status_code == 200, first.text
    first = first.json()
    assert first['model'] == 'Eleven v3'
    assert max(chunk['utf16_length'] for chunk in first['chunks']) <= 1000
    frozen = scope.load_settings(env['el'], 'elevenlabs', first['id'])
    assert frozen['production']['tts']['expected_voice'] == 'Minato'
    await project_defaults(env['a'], tts={'max_chunk_characters': 3000, 'model': 'Eleven v4', 'expected_voice': 'Other voice'})
    assert scope.load_settings(env['el'], 'elevenlabs', first['id']) == frozen
    second = await env['client'].post('/api/elevenlabs/jobs', json={**ctx, 'text': '日'*2400, 'max_chunk_characters': 1200, 'expected_voice': ''})
    assert second.status_code == 200, second.text
    assert max(chunk['utf16_length'] for chunk in second.json()['chunks']) <= 1200
    assert scope.load_settings(env['el'], 'elevenlabs', second.json()['id'])['production']['tts']['expected_voice'] == ''


@pytest.mark.asyncio
async def test_whisperx_resolves_omissions_and_preserves_frozen_options(env):
    await project_defaults(env['a'], whisperx={'language': 'ja', 'device': 'cuda', 'model': 'medium', 'video_duration_seconds': 125})
    await settings.save(env['va'], settings.VideoSettingsBody(overrides={'whisperx': {'batch_size': 4}}))
    ctx = {'project_id': env['a'], 'video_id': env['va']}
    data = io.BytesIO()
    with wave.open(data, 'wb') as audio:
        audio.setparams((1, 2, 16000, 0, 'NONE', 'not compressed')); audio.writeframes(b'\0\0'*160)
    imported = await env['client'].post('/api/whisperx/import', data=ctx, files={'file': ('speech.wav', data.getvalue(), 'audio/wav')})
    assert imported.status_code == 200, imported.text
    response = await env['client'].post('/api/whisperx/jobs', json={**ctx, 'source_id': imported.json()['id'], 'device': 'cpu'})
    assert response.status_code == 200, response.text
    options = response.json()['options']
    assert options == {'language': 'ja', 'device': 'cpu', 'model': 'medium', 'batch_size': 4, 'video_duration_seconds': 125}
    await project_defaults(env['a'], whisperx={'language': 'en'})
    assert env['wx'].job(response.json()['id'])['options'] == options


@pytest.mark.asyncio
async def test_stage_helper_keeps_explicit_settings_and_original_body(env):
    await project_defaults(env['a'], assembly={'image_motion': 'zoom_out', 'fps': 60})
    from agent.api.assembly import Plan
    body = Plan(srt_id='11111111-1111-1111-1111-111111111111', audio_id='22222222-2222-2222-2222-222222222222', fps=24)
    resolved = await settings.apply_stage(body, 'assembly', {'project_id': env['a'], 'video_id': env['va']})
    assert resolved.image_motion == 'zoom_out' and resolved.fps == 24
    assert body.image_motion == 'none'
