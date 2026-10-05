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
    # pytest gives each test a fresh event loop; contended locks bind to it.
    monkeypatch.setattr(s, '_db_lock', asyncio.Lock())
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


@pytest.mark.asyncio
async def test_srt_duration_rounds_up_and_failed_media_retry_keeps_success(document):
    data=await s.read_document(document)
    first,second=data['segments']
    for item in data['segments']:await s.save_concept(item['id'],CONCEPT)
    result=await s.generate_media(document,s.MediaBody(segment_ids=[first['id'],second['id']],kind='video',duration_mode='srt'))
    jobs={json.loads(j['payload'])['segment_id']:j for j in desktop.rows()}
    assert json.loads(jobs[first['id']]['payload'])['duration']==10  # 8.4 -> 10
    assert json.loads(jobs[second['id']]['payload'])['duration']==8
    desktop.update(jobs[first['id']]['id'],state='FAILED',remote=json.dumps({'workflows':[{'id':'existing'}]}))
    desktop.update(jobs[second['id']]['id'],state='COMPLETED')
    retried=await s.retry_failed(document,s.RetryBody(segment_ids=[first['id'],second['id']],kind='video'))
    assert retried['resumed']==[jobs[first['id']]['id']] and not retried['ids']
    assert retried['skipped']==[second['id']]
    assert len(desktop.rows())==2
    desktop.update(jobs[first['id']]['id'],state='FAILED',remote=None)
    with pytest.raises(HTTPException,match='409'):
        await s.retry_failed(document,s.RetryBody(segment_ids=[first['id']],kind='video'))
    retried=await s.retry_failed(document,s.RetryBody(segment_ids=[first['id']],kind='video',reviewed=True))
    assert len(retried['ids'])==1 and len(desktop.rows())==3
    assert json.loads(desktop.rows()[0]['payload'])['duration']==10
    # A second click cannot submit duplicates while the retry is queued.
    again=await s.retry_failed(document,s.RetryBody(segment_ids=[first['id']],kind='video',reviewed=True))
    assert not again['ids'] and again['skipped']==[first['id']]


@pytest.mark.asyncio
async def test_retry_failed_concepts_skips_successful_scene(document,monkeypatch):
    data=await s.read_document(document);first,second=data['segments']
    await s.save_concept(second['id'],CONCEPT)
    queued=await s.generate_concepts(document,s.GenerateBody(segment_ids=[first['id']]))
    async with s.transaction() as db:
        await db.execute("UPDATE concept_job SET state='FAILED' WHERE id=?",(queued['ids'][0],))
    retry=await s.retry_failed(document,s.RetryBody(segment_ids=[first['id'],second['id']],kind='concept',reviewed=True))
    assert len(retry['ids'])==1 and retry['skipped']==[second['id']]
    assert (await s.read_document(document))['segments'][1]['active_concept_id'] is not None


@pytest.mark.asyncio
async def test_separate_gpt_prompts_keep_image_media_and_snapshot_project_urls(document,monkeypatch):
    from agent.services import project_settings, chatgpt_gateway
    monkeypatch.setattr(chatgpt_gateway,'status',AsyncMock(return_value={'available':True,'extensionConnected':True}))
    monkeypatch.setattr(chatgpt_gateway,'ensure_project_workers',AsyncMock())
    data=await s.read_document(document);sid=data['segments'][0]['id'];pid=data['video']['project_id']
    settings=await project_settings.get(pid)
    settings=await project_settings.save(pid,project_settings.SettingsBody(**{**settings,'image_prompt_url':'https://chatgpt.com/g/g-images','video_prompt_url':'https://chatgpt.com/g/g-videos'}))
    first=(await s.generate_concepts(document,s.GenerateBody(segment_ids=[sid],provider='chatgpt-web',prompt_kind='image')))['ids'][0]
    job=await s.one('SELECT * FROM concept_job WHERE id=?',(first,))
    frozen=json.loads(job['payload']);assert frozen['project_settings']['image_prompt_url'].endswith('g-images')
    await project_settings.save(pid,project_settings.SettingsBody(**{**settings,'image_prompt_url':'https://chatgpt.com/g/g-new-images'}))
    assert json.loads((await s.one('SELECT payload FROM concept_job WHERE id=?',(first,)))['payload'])==frozen
    monkeypatch.setattr(s,'write_concept',AsyncMock(return_value=Concept(title='Scene',description='Scene',image_prompt='Same image')))
    await s.process_concept(job)
    media=s.MediaBody(segment_ids=[sid],kind='image')
    mid=(await s.generate_media(document,media))['ids'][0]
    original=json.loads(desktop.rows()[0]['payload'])
    assert original['project_settings']['image_prompt_url'].endswith('g-new-images')
    with pytest.raises(HTTPException):await s.generate_media(document,s.MediaBody(segment_ids=[sid],kind='video'))
    video_job=(await s.generate_concepts(document,s.GenerateBody(segment_ids=[sid],provider='chatgpt-web',prompt_kind='video')))['ids'][0]
    job=await s.one('SELECT * FROM concept_job WHERE id=?',(video_job,))
    assert json.loads(job['payload'])['retained_prompt']=='Same image'
    monkeypatch.setattr(s,'write_concept',AsyncMock(side_effect=ValueError('Provider failed')))
    await s.process_concept(job)
    retried=await s.retry_failed(document,s.RetryBody(segment_ids=[sid],provider='chatgpt-web',prompt_kind='video',kind='concept',reviewed=True))
    assert len(retried['ids'])==1
    monkeypatch.setattr(s,'write_concept',AsyncMock(return_value=Concept(title='Scene',description='Scene',image_prompt='Same image',video_prompt='New video')))
    await s.process_concept(await s.one('SELECT * FROM concept_job WHERE id=?',(retried['ids'][0],)))
    data=await s.read_document(document);segment=data['segments'][0]
    assert segment['image_ready'] and segment['video_ready']
    assert segment['media_jobs'][0]['current']
    assert segment['active_concept_id']!=original['concept_id']
    assert (await s.generate_media(document,media))['ids']==[]
    assert s.media_is_current(data['video'],data['document'],segment,original)
    await s.save_concept(sid,Concept(title='Scene',description='Scene',image_prompt='Changed image',video_prompt='New video'))
    data=await s.read_document(document)
    assert not s.media_is_current(data['video'],data['document'],data['segments'][0],original)


@pytest.mark.asyncio
async def test_text_prompt_import_200_cues_and_frozen_session(document, monkeypatch, tmp_path):
    from agent.services import chatgpt_gateway as gateway
    source = await s.read_document(document)
    video = await crud.create_video(project_id=source['video']['project_id'], title='200 SRT rows')
    def stamp(ms):
        return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02},{ms%1000:03}'
    content = '\ufeff'+'\r\n\r\n'.join(f'{i+1}\r\n{stamp(i*4000)} --> {stamp((i+1)*4000)}\r\n日本語 {i+1}\r\nSecond line.' for i in range(200))
    imported = await s.import_prompt_input(video['id'], s.PromptInputBody(srt_content=content, srt_name='200.srt', prompt_template='Create one image prompt.\nKeep the style.', prompt_name='instructions.txt'))
    assert len(imported['segments']) == 200
    assert imported['segments'][199]['text'] == '日本語 200\nSecond line.'
    assert imported['segments'][199]['end_ms'] == 800000
    monkeypatch.setattr(gateway, 'status', AsyncMock(return_value={'available':True,'extensionConnected':True,'hasReviewJobs':True}))
    ensure = AsyncMock(); monkeypatch.setattr(gateway, 'ensure_project_workers', ensure)
    ids = [row['id'] for row in imported['segments']]
    result = await s.generate_concepts(video['id'], s.GenerateBody(segment_ids=list(reversed(ids)), provider='chatgpt-web', prompt_kind='image'))
    jobs = await s.query('SELECT * FROM concept_job ORDER BY created')
    assert len(result['ids']) == len(jobs) == 200
    ensure.assert_awaited_once()
    assert [job['segment_id'] for job in jobs] == ids
    payloads = [json.loads(job['payload']) for job in jobs]
    assert len({p['text_session_id'] for p in payloads}) == 1
    assert result['batch_count'] == 40
    assert len({p['text_batch_id'] for p in payloads}) == 40
    assert [p['ordinal'] for p in payloads] == list(range(1, 201))
    assert all(p['prompt_template'] == imported['document']['prompt_template'] for p in payloads)
    assert payloads[199]['text'] == imported['segments'][199]['text']
    # Completing in a different order must still store each result on its own row.
    calls=[]
    async def complete(message, model, validate_payload, **options):
        calls.append((message, options))
        rows = [int(line.split(' ',1)[0]) for line in message.split('\n\n')]
        await asyncio.sleep(0)
        import zipfile
        token=s.uid();path=tmp_path/'flowkit-chatgpt'/token/'prompts.zip';path.parent.mkdir(parents=True)
        with zipfile.ZipFile(path,'w') as archive:
            for row in reversed(rows):archive.writestr(f'{row}.txt','Result: '+imported['segments'][row-1]['text'])
        return await validate_payload({'nativeDownload':{'path':str(path),'token':token}})
    from agent.services import prompt_batch
    monkeypatch.setattr(prompt_batch,'ARCHIVE_DIR',tmp_path/'saved')
    monkeypatch.setattr(gateway, 'complete', complete)
    for start in range(0,200,15):
        await asyncio.gather(*(s.process_concept(jobs[i]) for i in reversed(range(start,min(start+15,200),5))))
    assert len(calls) == 40
    assert all(len(message.split('\n\n')) == 5 for message,_ in calls)
    assert any(message.startswith('001 日本語 1 Second line.\n\n002 ') for message,_ in calls)
    assert all(options['prompt_template'].startswith(imported['document']['prompt_template']) and 'image_prompts.zip' in options['prompt_template'] for _,options in calls)
    assert all(options['temporary'] is False and options['composer_mode']=='work' and options['download_prompt_zip'] is True for _,options in calls)
    finished = await s.read_document(video['id'])
    assert all(row['job']['state']=='COMPLETED' and row['active_concept']['image_prompt']=='Result: '+row['text'] for row in finished['segments'])
    assert not (await s.generate_concepts(video['id'], s.GenerateBody(segment_ids=ids, provider='chatgpt-web', prompt_kind='image')))['ids']
    # Legacy callers cannot erase the saved TXT. Configuration survives restart.
    await s.save_document(video['id'], s.DocumentBody())
    await schema.close_db(); await schema.init_db()
    restored = await s.read_document(video['id'])
    assert restored['document']['prompt_template'] == imported['document']['prompt_template']
    assert restored['document']['prompt_name'] == 'instructions.txt'
    assert restored['document']['srt_name'] == '200.srt'
    with pytest.raises(HTTPException) as duplicate:
        await s.import_prompt_input(video['id'], s.PromptInputBody(srt_content=content, srt_name='other.srt', prompt_template='Changed'))
    assert duplicate.value.status_code == 409
    assert len((await s.read_document(video['id']))['segments']) == 200


@pytest.mark.asyncio
async def test_invalid_prompt_inputs_leave_no_partial_document(document):
    source = await s.read_document(document)
    video = await crud.create_video(project_id=source['video']['project_id'], title='Invalid input')
    for content, template in [('bad timestamps','instructions'),('1\n00:00:00,000 --> 00:00:04,000\nHello','   ')]:
        with pytest.raises(HTTPException):
            await s.import_prompt_input(video['id'], s.PromptInputBody(srt_content=content, srt_name='input.srt', prompt_template=template))
        assert (await s.read_document(video['id']))['document'] is None


@pytest.mark.asyncio
async def test_retry_failed_regeneration_is_target_specific_and_keeps_saved_result(document, monkeypatch):
    data=await s.read_document(document);sid=data['segments'][0]['id']
    await s.save_concept(sid, CONCEPT)
    queued=await s.generate_concepts(document,s.GenerateBody(segment_ids=[sid],provider='codex',prompt_kind='image',regenerate=True))
    monkeypatch.setattr(s,'write_concept',AsyncMock(side_effect=ValueError('Prompt generation failed')))
    await s.process_concept(await s.one('SELECT * FROM concept_job WHERE id=?',(queued['ids'][0],)))
    data=await s.read_document(document);row=data['segments'][0]
    assert row['active_concept']['image_prompt']==CONCEPT.image_prompt
    assert row['prompt_jobs']['image']['state']=='FAILED' and row['prompt_jobs']['video'] is None
    other=await s.retry_failed(document,s.RetryBody(segment_ids=[sid],provider='codex',prompt_kind='video',kind='concept',reviewed=True))
    assert other['ids']==[]
    retry=await s.retry_failed(document,s.RetryBody(segment_ids=[sid],provider='codex',prompt_kind='image',kind='concept',reviewed=True))
    assert len(retry['ids'])==1
    assert (await s.read_document(document))['segments'][0]['active_concept']['image_prompt']==CONCEPT.image_prompt

@pytest.mark.asyncio
async def test_batch_scheduler_saves_zip_group_before_starting_next_group(document, monkeypatch):
    from agent.services import chatgpt_gateway as gateway
    source = await s.read_document(document)
    video = await crud.create_video(project_id=source['video']['project_id'], title='13 rows')
    rows = [dict(start_ms=i*4000, end_ms=(i+1)*4000, text=f'Row {i+1}') for i in range(13)]
    await s.save_document(video['id'], s.DocumentBody(prompt_template='Visual instructions'))
    await s.import_segments(video['id'], s.ImportBody(format='json', content=json.dumps(rows)))
    data = await s.read_document(video['id'])
    monkeypatch.setattr(gateway, 'status', AsyncMock(return_value={'available':True,'extensionConnected':True,'availableSlots':3}))
    monkeypatch.setattr(gateway, 'ensure_project_workers', AsyncMock())
    result = await s.generate_concepts(video['id'], s.GenerateBody(segment_ids=[r['id'] for r in data['segments']],provider='chatgpt-web',prompt_kind='image'))
    assert result['batch_count'] == 3
    release = asyncio.Event()
    called = []
    async def write(payloads, save_result):
        called.append([p['ordinal'] for p in payloads])
        await release.wait()
        await save_result({p['ordinal']:Concept(title='Scene',description=p['text'],image_prompt='Result '+str(p['ordinal'])) for p in payloads})
    monkeypatch.setattr(s, 'write_concept_batch', write)
    runner = asyncio.create_task(s.run())
    try:
        for _ in range(100):
            if len(called) == 1:break
            await asyncio.sleep(.01)
        await asyncio.sleep(.05)
        assert called == [list(range(1,6))]
        assert len(await s.query("SELECT id FROM concept_job WHERE state='RUNNING'")) == 5
        first = data['segments'][0]
        await s.edit_segment(first['id'],s.SegmentBody(start_ms=0,end_ms=4000,text='Changed while running'))
        release.set()
        for _ in range(400):
            if not await s.query("SELECT id FROM concept_job WHERE state IN ('QUEUED','RUNNING')"):break
            await asyncio.sleep(.01)
        final = await s.read_document(video['id'])
        assert final['segments'][0]['job']['state'] == 'STALE'
        assert final['segments'][0]['active_concept_id'] is None
        assert final['segments'][0]['concepts'][0]['image_prompt'] == 'Result 1'
        assert all(r['job']['state']=='COMPLETED' and r['active_concept']['image_prompt']=='Result '+str(r['ordinal']) for r in final['segments'][1:])
        assert len(called) == 3
    finally:
        release.set();runner.cancel()
        with pytest.raises(asyncio.CancelledError):await runner


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', ['incomplete','busy','review','cancel'])
async def test_batch_failure_and_cancel_keep_all_rows_consistent(document, monkeypatch, failure):
    from agent.services import chatgpt_gateway as gateway
    await s.save_document(document,s.DocumentBody(prompt_template='Instructions'))
    data = await s.read_document(document)
    monkeypatch.setattr(gateway,'status',AsyncMock(return_value={'available':True,'extensionConnected':True}))
    monkeypatch.setattr(gateway,'ensure_project_workers',AsyncMock())
    queued = await s.generate_concepts(document,s.GenerateBody(segment_ids=[r['id'] for r in data['segments']],provider='chatgpt-web',prompt_kind='image'))
    async def incomplete(payloads,save_result):await save_result({1:CONCEPT})
    writer = AsyncMock(side_effect=incomplete)
    if failure=='busy':writer.side_effect=gateway.GatewayBusy('Busy')
    if failure=='review':writer.side_effect=gateway.GatewayReviewRequired('Ambiguous response')
    monkeypatch.setattr(s,'write_concept_batch',writer)
    if failure=='cancel':await s.cancel_concepts(document)
    job = await s.one('SELECT * FROM concept_job WHERE id=?',(queued['ids'][0],))
    await asyncio.gather(s.process_concept(job),s.process_concept(job))
    final = await s.read_document(document)
    state = dict(incomplete='FAILED',busy='QUEUED',review='NEEDS_REVIEW',cancel='CANCELLED')[failure]
    assert all(r['job']['state']==state and not r['concepts'] for r in final['segments'])
    if failure not in {'busy','cancel'}:assert writer.await_count==1
    if failure=='cancel':writer.assert_not_awaited()


@pytest.mark.asyncio
async def test_batch_skips_finished_rows_and_retry_keeps_original_row_number(document, monkeypatch):
    from agent.services import chatgpt_gateway as gateway
    await s.save_document(document,s.DocumentBody(prompt_template='Instructions'))
    data = await s.read_document(document)
    await s.save_concept(data['segments'][0]['id'],CONCEPT)
    monkeypatch.setattr(gateway,'status',AsyncMock(return_value={'available':True,'extensionConnected':True}))
    monkeypatch.setattr(gateway,'ensure_project_workers',AsyncMock())
    body=s.GenerateBody(segment_ids=[r['id'] for r in data['segments']],provider='chatgpt-web',prompt_kind='image')
    queued=await s.generate_concepts(document,body)
    assert len(queued['ids'])==queued['batch_count']==1
    job=await s.one('SELECT * FROM concept_job WHERE id=?',(queued['ids'][0],))
    assert json.loads(job['payload'])['ordinal']==2
    monkeypatch.setattr(s,'write_concept_batch',AsyncMock(side_effect=ValueError('Incomplete reply')))
    await s.process_concept(job)
    retry=await s.retry_failed(document,s.RetryBody(segment_ids=[data['segments'][1]['id']],kind='concept',reviewed=True,provider='chatgpt-web',prompt_kind='image'))
    retried=await s.one('SELECT * FROM concept_job WHERE id=?',(retry['ids'][0],))
    original,payload=json.loads(job['payload']),json.loads(retried['payload'])
    assert payload['ordinal']==2 and payload['text_batch_id']!=original['text_batch_id']
    assert payload['text_session_id']!=original['text_session_id']
    assert (await s.read_document(document))['segments'][0]['active_concept']['image_prompt']==CONCEPT.image_prompt
