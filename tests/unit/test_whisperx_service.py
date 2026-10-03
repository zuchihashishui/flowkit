import asyncio
import json
import sys
import time
from pathlib import Path
from types import SimpleNamespace
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from agent.services import whisperx_service as module
from agent.api import whisperx as api

OPTIONS = {'model':'large-v3','device':'cpu','language':'ja','batch_size':8}
SOURCE_ID = '11111111-1111-4111-8111-111111111111'

@pytest.fixture
def service(tmp_path):
    audio = tmp_path / 'merged.mp3'
    audio.write_bytes(b'fixture')
    source = {'id':SOURCE_ID,'title':'日本語','updated':time.time(), 'merged_url':'/audio/merged'}
    origin = SimpleNamespace(job=lambda _:source, jobs=lambda:[source], audio_path=lambda *_:audio)
    return module.WhisperXService(tmp_path/'jobs.db',tmp_path/'output',origin)


def stub_runner(tmp_path, monkeypatch, body):
    script=tmp_path/'runner.py'
    script.write_text('import json,sys,time\nfrom pathlib import Path\n'+body)
    monkeypatch.setattr(module,'RUNNER',script)
    monkeypatch.setattr(module,'python_bin',lambda:sys.executable)

@pytest.mark.asyncio
async def test_worker_runs_separate_process_and_persists_complete_native_json(service,tmp_path,monkeypatch):
    stub_runner(tmp_path,monkeypatch,"""
r=json.loads(Path(sys.argv[2]).read_text())
print('FLOWKIT_WX '+json.dumps({'phase':'ALIGNING','message':'Align'}),flush=True)
Path(r['output']).write_text(json.dumps({'language':'ja','segments':[{'start':0,'end':1,'text':'日'}], 'word_segments':[{'word':'日','start':0.1,'end':0.4,'score':0.9},{'word':'?'}]}))
""")
    job=service.enqueue(SOURCE_ID,OPTIONS)
    assert service.enqueue(SOURCE_ID,OPTIONS)['id']==job['id']
    await service.step()
    assert service.job(job['id'])['state']=='COMPLETED'
    result=json.loads(service.result_path(job['id']).read_text())
    assert result['word_segments'][0]['start']==0.1
    assert 'start' not in result['word_segments'][1]
    assert service.job(job['id'])['split_available']
    assert service.job(job['id'])['transcript_split']['video_duration_seconds']==100
    assert service.result_path(job['id'],'video').exists()
    assert json.loads(service.result_path(job['id'],'image').read_text())['word_segments']==[]
    assert service.active_id is None and service.process is None
    assert module.WhisperXService(service.store,service.output,service.source).job(job['id'])['state']=='COMPLETED'

@pytest.mark.asyncio
async def test_worker_failure_is_not_success_and_logs_are_exposed(service,tmp_path,monkeypatch):
    stub_runner(tmp_path,monkeypatch,"raise RuntimeError('CUDA fixture unavailable')\n")
    job=service.enqueue(SOURCE_ID,OPTIONS)
    await service.step()
    assert service.job(job['id'])['state']=='FAILED'
    assert 'CUDA fixture unavailable' in service.job(job['id'])['error']
    with pytest.raises(ValueError):service.result_path(job['id'])

@pytest.mark.asyncio
async def test_missing_python_fails_actionably(service,monkeypatch):
    monkeypatch.setattr(module,'python_bin',lambda:'/missing/whisperx/python')
    job=service.enqueue(SOURCE_ID,OPTIONS)
    await service.step()
    assert service.job(job['id'])['state']=='FAILED'
    assert not (await service.check())['ok']

@pytest.mark.asyncio
async def test_cancel_stops_running_process(service,tmp_path,monkeypatch):
    stub_runner(tmp_path,monkeypatch,"time.sleep(30)\n")
    job=service.enqueue(SOURCE_ID,OPTIONS)
    task=asyncio.create_task(service.step())
    for _ in range(100):
        if service.process:break
        await asyncio.sleep(0.01)
    await service.cancel(job['id'])
    await asyncio.wait_for(task,3)
    assert service.job(job['id'])['state']=='CANCELLED'
    assert service.process is None

@pytest.mark.asyncio
async def test_automatic_discovery_only_future_merges_and_no_retry(service):
    assert service.settings()['auto'] is False
    service.configure({**OPTIONS,'auto':True})
    await service.discover()
    assert service.jobs()==[]
    service.configure({'auto':False})
    service.source.job(SOURCE_ID)['merged_url']=None
    service.configure({'auto':True})
    service.source.job(SOURCE_ID)['merged_url']='/audio/merged'
    await service.discover()
    assert len(service.jobs())==1
    service.update(service.jobs()[0]['id'],state='FAILED')
    await service.discover()
    assert len(service.jobs())==1


@pytest.mark.asyncio
async def test_api_options_and_result_routes(service,monkeypatch):
    monkeypatch.setattr(api,'service',service)
    app=FastAPI();app.include_router(api.router,prefix='/api')
    from httpx import AsyncClient, ASGITransport
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        job=(await client.post('/api/whisperx/jobs',json={'source_id':SOURCE_ID,**OPTIONS})).json()
        assert job['options']=={**OPTIONS,'video_duration_seconds':100}
        assert (await client.get(f"/api/whisperx/jobs/{job['id']}/result")).status_code==404
        assert (await client.post('/api/whisperx/jobs',json={'source_id':'../../file',**OPTIONS})).status_code==422
        assert (await client.post('/api/whisperx/jobs',json={'source_id':SOURCE_ID,**OPTIONS,'batch_size':0})).status_code==422
        assert (await client.post('/api/whisperx/jobs',json={'source_id':SOURCE_ID,**OPTIONS,'model':'../anything'})).status_code==422
        assert (await client.post('/api/whisperx/settings',json={**OPTIONS,'auto':True})).json()['auto']


def test_json_writer_preserves_native_words_characters_and_missing_timestamps(tmp_path,monkeypatch):
    import importlib.util
    spec=importlib.util.spec_from_file_location('wx_runner',module.RUNNER)
    runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
    monkeypatch.setattr(runner.importlib.metadata,'version',lambda _: 'test')
    aligned={'segments':[{'start':0,'end':2,'text':'日本語','words':[{'word':'日','start':0.1,'end':0.4,'score':0.8}], 'chars':[{'char':'日','start':0.1,'end':0.4}]}], 'word_segments':[{'word':'日','start':0.1,'end':0.4,'score':0.8},{'word':'?'}]}
    target=tmp_path/'transcript.json'
    runner.write_result(aligned,'ja','merged.mp3',OPTIONS,target,duration=2.75)
    saved=json.loads(target.read_text())
    assert saved['segments']==aligned['segments']
    assert saved['word_segments']==aligned['word_segments']
    assert saved['metadata']['untimed_words']==1
    assert saved['metadata']['time_unit']=='seconds'
    assert saved['metadata']['audio_duration_seconds']==2.75
    assert not target.with_suffix('.tmp').exists()

@pytest.mark.asyncio
async def test_imported_audio_is_copied_persisted_and_used_by_worker(service,tmp_path,monkeypatch):
    import io
    from starlette.datastructures import UploadFile
    audio=b'ID3'+b'x'*(2*1024*1024)
    import tempfile
    stream=tempfile.SpooledTemporaryFile(max_size=3*1024*1024)
    stream.write(audio); stream.seek(0)
    upload=UploadFile(stream,filename='日本語 narration.mp3')
    imported=await service.import_audio(upload)
    await upload.close()
    assert imported['bytes']==len(audio)
    restored=module.WhisperXService(service.store,service.output,service.source)
    assert restored.imported_sources()[0]['title']=='日本語 narration.mp3'
    _,path=restored.resolve_source(imported['id'])
    assert path.read_bytes()==audio
    stub_runner(tmp_path,monkeypatch,"""
r=json.loads(Path(sys.argv[2]).read_text())
assert Path(r['audio']).read_bytes().startswith(b'ID3')
Path(r['output']).write_text(json.dumps({'segments':[], 'word_segments':[]}))
""")
    job=restored.enqueue(imported['id'],OPTIONS)
    await restored.step()
    assert restored.job(job['id'])['state']=='COMPLETED'

@pytest.mark.asyncio
async def test_import_api_rejects_empty_or_unsupported_files_and_exposes_sources(service,monkeypatch):
    from httpx import AsyncClient, ASGITransport
    monkeypatch.setattr(api,'service',service)
    app=FastAPI();app.include_router(api.router,prefix='/api')
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
        for name,data in [('empty.mp3',b''),('script.exe',b'fake')]:
            response=await client.post('/api/whisperx/import',files={'file':(name,data)})
            assert response.status_code==422
        response=await client.post('/api/whisperx/import',files={'file':('../../outside.wav',b'RIFFfixture')})
        assert response.status_code==200
        imported=response.json()
        assert imported['title']=='outside.wav'
        assert (await client.get('/api/whisperx/status')).json()['imported_sources'][0]['id']==imported['id']
        assert service.resolve_source(imported['id'])[1].parent==service.output/'_imports'
        assert not list((service.output/'_imports').glob('*.part'))

@pytest.mark.asyncio
async def test_live_progress_visible_before_completion_and_preserved_after_restart(service,tmp_path,monkeypatch):
    stub_runner(tmp_path,monkeypatch,"""
r=json.loads(Path(sys.argv[2]).read_text())
print('FLOWKIT_WX '+json.dumps({'phase':'TRANSCRIBING','message':'Speech','phase_percent':50,'audio_seconds':600,'audio_done_seconds':300}),flush=True)
time.sleep(.2)
print('FLOWKIT_WX '+json.dumps({'phase':'ALIGNING','message':'Align','phase_percent':25,'segments_done':10,'segments_total':40,'units_done':2500,'units_total':10000,'unit':'characters'}),flush=True)
time.sleep(.4)
Path(r['output']).write_text(json.dumps({'language':'ja','segments':[{'start':0,'end':1,'text':'日'}], 'word_segments':[{'word':'日'}]}))
print('FLOWKIT_WX '+json.dumps({'phase':'COMPLETED','message':'Saved','phase_percent':100}),flush=True)
""")
    job=service.enqueue(SOURCE_ID,OPTIONS)
    task=asyncio.create_task(service.step())
    for _ in range(100):
        current=service.job(job['id'])
        if current['phase']=='ALIGNING':break
        await asyncio.sleep(.01)
    assert current['state']=='RUNNING'
    assert current['progress']['phase_percent']==25
    assert current['progress']['units_done']==2500
    assert current['progress']['audio_seconds']==600
    assert 'audio_done_seconds' not in current['progress']  # no stale position from another phase
    assert current['elapsed_seconds']>0
    await task
    completed=service.job(job['id'])
    assert completed['state']=='COMPLETED' and completed['progress']['output_words']==1
    assert completed['finished']>=completed['started']
    restored=module.WhisperXService(service.store,service.output,service.source).job(job['id'])
    assert restored['progress']==completed['progress']
    assert restored['elapsed_seconds']==completed['elapsed_seconds']

@pytest.mark.asyncio
async def test_late_progress_ignored_after_cancel_and_runner_completion_requires_validation(service):
    job=service.enqueue(SOURCE_ID,OPTIONS)
    service.update(job['id'],state='RUNNING',started=time.time(),phase='STARTING')
    service.worker_progress(job['id'],{'phase':'COMPLETED','phase_percent':100})
    current=service.job(job['id'])
    assert current['state']=='RUNNING' and current['phase']=='VERIFYING_JSON'
    assert 'phase_percent' not in current['progress']
    await service.cancel(job['id'])
    before=service.job(job['id'])
    service.worker_progress(job['id'],{'phase':'ALIGNING','phase_percent':70})
    after=service.job(job['id'])
    assert after['state']=='CANCELLED' and after['phase']=='CANCELLED'
    assert after['progress']==before['progress']
    assert after['elapsed_seconds']==before['elapsed_seconds']


def test_old_job_database_migrates_without_losing_jobs(service):
    import sqlite3
    with sqlite3.connect(service.store) as db:
        db.execute('CREATE TABLE wx_jobs(id TEXT PRIMARY KEY,source_id TEXT,title TEXT,state TEXT,phase TEXT,error TEXT,options TEXT,created REAL,updated REAL)')
        db.execute('INSERT INTO wx_jobs VALUES(?,?,?,?,?,?,?,?,?)',('old',SOURCE_ID,'Old audio','COMPLETED','COMPLETED',None,json.dumps(OPTIONS),1,2))
    old=service.jobs()[0]
    assert old['id']=='old' and old['options']==OPTIONS and old['progress']=={}
    new=service.enqueue(SOURCE_ID,OPTIONS)
    assert new['state']=='QUEUED' and len(service.jobs())==2


@pytest.mark.asyncio
async def test_split_api_and_exports_work_on_completed_old_job_without_rerunning_whisperx(service,monkeypatch):
    from httpx import AsyncClient,ASGITransport
    monkeypatch.setattr(api,'service',service)
    app=FastAPI();app.include_router(api.router,prefix='/api')
    job=service.enqueue(SOURCE_ID,OPTIONS);jid=job['id']
    folder=service.output/jid;folder.mkdir(parents=True)
    words=[{'word':'first','start':0,'end':1},{'word':'next','start':101,'end':102}]
    original=json.dumps({'segments':[{'text':'first next','start':0,'end':102,'words':words}], 'word_segments':words}).encode()
    (folder/'transcript.json').write_bytes(original)
    service.update(jid,state='COMPLETED',phase='COMPLETED')
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
        root=f'/api/whisperx/jobs/{jid}'
        assert (await client.get(root+'/result/video')).status_code==404
        response=await client.post(root+'/split',json={'video_duration_seconds':100})
        assert response.status_code==200 and response.json()['split_available']
        assert response.json()['transcript_split']['image_words']==1
        assert (await client.get(root+'/result')).content==original
        for variant,expected in [('video','first'),('image','next')]:
            result=await client.get(root+'/result/'+variant)
            assert result.status_code==200
            assert f'transcript_{variant}.json' in result.headers['content-disposition']
            assert result.json()['word_segments'][0]['word']==expected
            assert (await client.get(root+'/preview/'+variant)).json()['word_count']==1
        assert (await client.post(root+'/split',json={'video_duration_seconds':-1})).status_code==422
        assert (await client.get(root+'/result/private')).status_code==422
        assert (await client.post(root+'/split',json={'video_duration_seconds':200})).json()['transcript_split']['image_words']==0
    assert service.process is None and service.active_id is None
    assert (folder/'transcript.json').read_bytes()==original
    assert module.WhisperXService(service.store,service.output,service.source).job(jid)['transcript_split']['video_duration_seconds']==200


def test_split_default_and_saved_settings_are_persisted_per_new_job(service):
    assert service.settings()['video_duration_seconds']==100
    service.configure({'video_duration_seconds':75.5})
    restored=module.WhisperXService(service.store,service.output,service.source)
    assert restored.settings()['video_duration_seconds']==75.5
    job=restored.enqueue(SOURCE_ID,{**OPTIONS,'video_duration_seconds':75.5})
    restored.configure({'video_duration_seconds':200})
    assert restored.job(job['id'])['options']['video_duration_seconds']==75.5
