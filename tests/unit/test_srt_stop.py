import asyncio
import pytest
from agent.services import chatgpt_gateway as gateway
from agent.services.srt_service import SRTService

@pytest.mark.asyncio
async def test_stop_running_keeps_files_and_rejects_late_completion(tmp_path,monkeypatch):
    service=SRTService(tmp_path/'db',tmp_path/'out')
    src=service.import_bytes(b'{"segments":[]}','input.json')
    jid=service.enqueue(src['id'],'prompt','auto',1800,method='legacy-srt')['id']
    started=asyncio.Event();finish=asyncio.Event();stopped=[]
    async def complete(prompt,model,**kwargs):
        assert kwargs['srt_job_id']==jid
        started.set();await finish.wait()
        kwargs['validate']('1\n00:00:00,000 --> 00:00:01,000\nHello\n')
    async def stop(job_id):
        stopped.append(job_id)
        return {'ok':True}
    monkeypatch.setattr(gateway,'complete',complete);monkeypatch.setattr(gateway,'stop_srt',stop)
    task=asyncio.create_task(service.process(service.jobs()[0]));await started.wait()
    saved=service.output/jid/'existing-download.srt';saved.write_text('retained')
    assert (await service.stop(jid))['state']=='CANCELLED'
    finish.set();await task
    assert stopped==[jid];assert service.jobs()[0]['state']=='CANCELLED'
    assert saved.read_text()=='retained'
    assert not (service.output/jid/'subtitles.srt').exists()
    assert service.active_id is None
    await service.process(service.jobs()[0])
    assert service.jobs()[0]['state']=='CANCELLED'

@pytest.mark.asyncio
async def test_cancel_queued_never_contacts_browser(tmp_path,monkeypatch):
    service=SRTService(tmp_path/'db',tmp_path/'out')
    src=service.import_bytes(b'{"segments":[]}','input.json')
    jid=service.enqueue(src['id'],'prompt','auto',1800,method='legacy-srt')['id']
    async def forbidden(*args):raise AssertionError('Queued job has no active browser request')
    monkeypatch.setattr(gateway,'stop_srt',forbidden)
    assert (await service.stop(jid))['state']=='CANCELLED'
    assert (await service.stop(jid))['cancelled']==0

@pytest.mark.asyncio
async def test_prepare_reports_queued_without_409_and_recovers_orphan_running(tmp_path,monkeypatch):
    import importlib
    api=importlib.import_module('agent.api.srt')
    from agent.services import project_settings
    service=SRTService(tmp_path/'db',tmp_path/'out')
    src=service.import_bytes(b'{"segments":[]}','input.json')
    jid=service.enqueue(src['id'],'prompt','auto',1800,method='legacy-srt')['id']
    async def context(*args):return {}
    async def snapshot(*args):return {'chatgpt_url':'https://chatgpt.com/'}
    called=[]
    async def prepare(*args):called.append(args);return {'token':'new'}
    monkeypatch.setattr(api,'service',service);monkeypatch.setattr(api,'context',context)
    monkeypatch.setattr(project_settings,'snapshot',snapshot);monkeypatch.setattr(gateway,'prepare_srt',prepare)
    result=await api.prepare_tab(api.PrepareTab())
    assert result['state']=='queued' and result['job_id']==jid and len(called)==1
    assert service.preparing is False
    from agent.services import workflow_scope
    assert workflow_scope.load_settings(service,'srt',jid)['srt_prepared_token']=='new'
    service.update(jid,'RUNNING');service.active_id=jid
    assert (await api.prepare_tab(api.PrepareTab()))['state']=='running'
    assert len(called)==1
    service.active_id=None
    assert (await api.prepare_tab(api.PrepareTab()))['token']=='new'
    assert service.jobs()[0]['state']=='NEEDS_REVIEW'
