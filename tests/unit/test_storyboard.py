import asyncio
import io
import json
import wave
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from fastapi import HTTPException, UploadFile
from agent.api import storyboard as s, desktop
from agent.db import schema, crud
from agent.services.concept_writer import Concept, parse_concept, make_prompt


CONCEPT = Concept(title='Paper boat', description='A paper boat illustrates the journey.', image_prompt='A paper boat on still blue water, soft light.', video_prompt='The boat drifts slowly as the camera follows.')


@pytest_asyncio.fixture
async def document(tmp_path, monkeypatch):
    monkeypatch.setattr(schema, 'DB_PATH', tmp_path/'app.db')
    monkeypatch.setattr(desktop, 'STORE', tmp_path/'jobs.db')
    monkeypatch.setattr(s, 'AUDIO_DIR', tmp_path/'audio')
    monkeypatch.setattr(desktop, 'get_flow_client', lambda: SimpleNamespace(connected=True))
    monkeypatch.setattr(s.shutil, 'which', lambda _: '/fake/tool')
    await schema.init_db()
    p = await crud.create_project(name='Test project', material='realistic')
    v = await crud.create_video(project_id=p['id'], title='Script collection')
    await s.save_document(v['id'], s.DocumentBody(script_text='A long journey begins.',visual_style='Paper art'))
    await s.import_segments(v['id'], s.ImportBody(format='json',content=json.dumps([
        {'start_ms':0,'end_ms':8400,'text':'The journey begins.'},
        {'start_ms':9200,'end_ms':17200,'text':'We continue.'}
    ])))
    yield v['id']
    await schema.close_db()


def test_srt_milliseconds_and_multiline():
    cues = s.parse_segments(s.ImportBody(format='srt',content='\ufeff1\n00:00:00,125 --> 00:00:08,456\n日本語の\nナレーション\n\n2\n00:00:09,001 --> 00:00:12,500\nNext'))
    assert (cues[0].start_ms,cues[0].end_ms)==(125,8456)
    assert cues[0].text=='日本語の\nナレーション'
    assert cues[1].start_ms==9001


def test_whisper_json_seconds():
    cues=s.parse_segments(s.ImportBody(format='json',content='{"segments":[{"start":0.125,"end":8.456,"text":"Hello"}]}'))
    assert cues[0].end_ms==8456


@pytest.mark.parametrize('data', [
    '[{"start_ms":8000,"end_ms":7000,"text":"x"}]',
    '[{"start_ms":0,"end_ms":8000,"text":"x"},{"start_ms":7000,"end_ms":9000,"text":"y"}]',
    '[{"start_ms":0,"end_ms":8000,"text":"  "}]', '[]'
])
def test_bad_segments_rejected(data):
    with pytest.raises(ValueError):
        s.parse_segments(s.ImportBody(format='json',content=data))


def test_ai_json_is_validated():
    assert parse_concept('```json\n'+CONCEPT.model_dump_json()+'\n```')==CONCEPT
    with pytest.raises(ValueError):
        parse_concept('{"image_prompt":"fake partial result"}')
    with pytest.raises(ValueError):
        parse_concept('not JSON')


@pytest.mark.asyncio
async def test_schema_and_segment_identity_survive_restart(document):
    first=await s.read_document(document)
    assert first['warnings'][0].startswith('Gap before segment 2: 800 ms')
    await schema.close_db()
    await schema.init_db()
    second=await s.read_document(document)
    assert [r['id'] for r in first['segments']]==[r['id'] for r in second['segments']]
    with pytest.raises(HTTPException) as exc:
        await s.import_segments(document,s.ImportBody(format='json',content='[{"start_ms":0,"end_ms":1000,"text":"Duplicate"}]'))
    assert exc.value.status_code==409


@pytest.mark.asyncio
async def test_ai_concepts_keep_versions_and_media_snapshot(document,monkeypatch):
    monkeypatch.setattr(s,'write_concept',AsyncMock(return_value=CONCEPT))
    doc=await s.read_document(document);sid=doc['segments'][0]['id']
    body=s.GenerateBody(segment_ids=[sid],provider='codex')
    queued=await s.generate_concepts(document,body)
    again=await s.generate_concepts(document,body)
    assert len(queued['ids'])==1 and again['ids']==[]
    job=await s.one('SELECT * FROM concept_job WHERE id=?',(queued['ids'][0],))
    payload=json.loads(job['payload']);assert payload['next_text']=='We continue.'
    assert 'Paper art' in make_prompt(payload)
    await s.process_concept(job)
    doc=await s.read_document(document);segment=doc['segments'][0];cid=segment['active_concept_id']
    assert segment['ready'] and segment['active_concept']['version']==1
    media=s.MediaBody(segment_ids=[sid],kind='image')
    result=await s.generate_media(document,media)
    assert len(result['ids'])==1
    assert (await s.generate_media(document,media))['ids']==[]
    snapshot=json.loads(desktop.rows()[0]['payload'])
    assert snapshot['segment_id']==sid and snapshot['concept_id']==cid
    assert snapshot['start_ms']==0 and snapshot['end_ms']==8400
    await s.save_concept(sid,CONCEPT.model_copy(update={'image_prompt':'A different boat'}))
    assert json.loads(desktop.rows()[0]['payload'])['prompt']==CONCEPT.image_prompt
    current=(await s.read_document(document))['segments'][0]
    assert len(current['concepts'])==2
    await s.select_concept(cid)
    assert (await s.read_document(document))['segments'][0]['active_concept_id']==cid


@pytest.mark.asyncio
async def test_changed_source_prevents_stale_ai_activation(document,monkeypatch):
    sid=(await s.read_document(document))['segments'][0]['id']
    queued=await s.generate_concepts(document,s.GenerateBody(segment_ids=[sid]))
    async def writing(payload):
        await s.edit_segment(sid,s.SegmentBody(start_ms=0,end_ms=8400,text='Changed meaning'))
        return CONCEPT
    monkeypatch.setattr(s,'write_concept',writing)
    await s.process_concept(await s.one('SELECT * FROM concept_job WHERE id=?',(queued['ids'][0],)))
    segment=(await s.read_document(document))['segments'][0]
    assert segment['job']['state']=='STALE'
    assert not segment['ready'] and segment['active_concept_id'] is None
    with pytest.raises(HTTPException):
        await s.select_concept(segment['concepts'][0]['id'])
    with pytest.raises(HTTPException):
        await s.generate_media(document,s.MediaBody(segment_ids=[sid],kind='image'))


@pytest.mark.asyncio
async def test_style_edit_invalidates_current_concept(document):
    sid=(await s.read_document(document))['segments'][0]['id']
    await s.save_concept(sid,CONCEPT)
    await s.save_document(document,s.DocumentBody(script_text='A long journey begins.',visual_style='Clay animation'))
    assert not (await s.read_document(document))['segments'][0]['ready']


@pytest.mark.asyncio
async def test_failure_is_visible_and_not_retried(document,monkeypatch):
    sid=(await s.read_document(document))['segments'][0]['id']
    ids=(await s.generate_concepts(document,s.GenerateBody(segment_ids=[sid])))['ids']
    writer=AsyncMock(side_effect=ValueError('Invalid AI JSON'))
    monkeypatch.setattr(s,'write_concept',writer)
    job=await s.one('SELECT * FROM concept_job WHERE id=?',(ids[0],))
    await s.process_concept(job)
    await s.process_concept(job)
    assert writer.await_count==1
    item=(await s.read_document(document))['segments'][0]
    assert item['job']['state']=='FAILED'
    assert 'Invalid AI JSON' in item['job']['error']
    assert item['concepts']==[]


@pytest.mark.asyncio
async def test_cancelled_concept_cannot_start(document,monkeypatch):
    sid=(await s.read_document(document))['segments'][0]['id']
    jid=(await s.generate_concepts(document,s.GenerateBody(segment_ids=[sid])))['ids'][0]
    job=await s.one('SELECT * FROM concept_job WHERE id=?',(jid,))
    await s.cancel_concepts(document)
    writer=AsyncMock();monkeypatch.setattr(s,'write_concept',writer)
    await s.process_concept(job)
    writer.assert_not_called()


@pytest.mark.asyncio
async def test_audio_import_and_file_boundary(document,tmp_path):
    buf=io.BytesIO()
    with wave.open(buf,'wb') as wav:
        wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(24000);wav.writeframes(b'\0\0'*24000)
    buf.seek(0)
    result=await s.upload_audio(document,UploadFile(filename='narration.wav',file=buf))
    assert result['duration_ms']==1000
    audio=await s.get_audio(document)
    assert str(audio.path).endswith('.wav')
    assert any('beyond' in warning for warning in (await s.read_document(document))['warnings'])
    outside=tmp_path/'outside.wav';outside.write_bytes(b'private')
    async with s.transaction() as db:
        await db.execute('UPDATE script_document SET audio_path=? WHERE video_id=?',(str(outside),document))
    with pytest.raises(HTTPException):
        await s.get_audio(document)


@pytest.mark.asyncio
async def test_overlap_edit_is_rejected(document):
    sid=(await s.read_document(document))['segments'][0]['id']
    with pytest.raises(HTTPException) as exc:
        await s.edit_segment(sid,s.SegmentBody(start_ms=0,end_ms=10000,text='overlap'))
    assert exc.value.status_code==409


def test_windows_npm_launcher_avoids_command_shell(tmp_path,monkeypatch):
    from agent.services import cli_launch
    launcher=tmp_path/'codex.cmd';launcher.write_text('@echo off')
    script=tmp_path/'node_modules/@openai/codex/bin/codex.js';script.parent.mkdir(parents=True);script.write_text('// test fixture')
    monkeypatch.setattr(cli_launch.shutil,'which',lambda name:str(launcher) if name=='codex' else 'node.exe')
    prompt='Quoted "text" & commands are source data'
    args=cli_launch.windows_cli_args(('codex','exec',prompt))
    assert args==('node.exe',str(script),'exec',prompt)


@pytest.mark.asyncio
async def test_provider_missing_and_wrong_collection_do_not_queue(document,monkeypatch):
    sid=(await s.read_document(document))['segments'][0]['id']
    monkeypatch.setattr(s.shutil,'which',lambda _:None)
    with pytest.raises(HTTPException) as exc:
        await s.generate_concepts(document,s.GenerateBody(segment_ids=[sid]))
    assert exc.value.status_code==503
    monkeypatch.setattr(s.shutil,'which',lambda _:'/fake/tool')
    with pytest.raises(HTTPException):
        await s.generate_concepts(document,s.GenerateBody(segment_ids=[sid,'foreign-segment']))
    assert await s.query('SELECT * FROM concept_job')==[]


@pytest.mark.asyncio
async def test_storyboard_http_contract(document):
    from fastapi import FastAPI
    from httpx import AsyncClient, ASGITransport
    app=FastAPI();app.include_router(s.router,prefix='/api')
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
        result=await client.get('/api/storyboard/videos/'+document)
        assert result.status_code==200
        sid=result.json()['segments'][0]['id']
        result=await client.post('/api/storyboard/segments/'+sid+'/concepts',json=CONCEPT.model_dump())
        assert result.status_code==200
        media=await client.post('/api/storyboard/videos/'+document+'/generate-media',json={'segment_ids':[sid],'kind':'image'})
        assert media.status_code==200 and len(media.json()['ids'])==1

@pytest.mark.asyncio
async def test_chatgpt_concept_failure_requires_review(document, monkeypatch):
    from agent.services import chatgpt_gateway as g
    monkeypatch.setattr(g, 'status', AsyncMock(return_value={'available':True,'extensionConnected':True}))
    segments = await s.query('SELECT * FROM script_segment ORDER BY ordinal')
    result = await s.generate_concepts(document,s.GenerateBody(segment_ids=[segments[0]['id']],provider='chatgpt-web'))
    job = (await s.query('SELECT * FROM concept_job WHERE id=?',(result['ids'][0],)))[0]
    monkeypatch.setattr(s,'write_concept',AsyncMock(side_effect=g.GatewayReviewRequired('Check original response')))
    await s.process_concept(job)
    stored = (await s.query('SELECT * FROM concept_job WHERE id=?',(job['id'],)))[0]
    assert stored['state']=='NEEDS_REVIEW'
    assert not await s.query('SELECT * FROM scene_concept')
