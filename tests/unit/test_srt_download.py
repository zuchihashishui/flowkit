import base64
import json
from uuid import uuid4
import httpx
import pytest
from agent.services.srt_service import SRTService
from agent.services import chatgpt_gateway as gateway

SRT = b'1\r\n00:00:00,000 --> 00:00:04,000\r\nHello\r\n'

@pytest.mark.asyncio
@pytest.mark.parametrize('bad', [False, True])
async def test_original_json_prompt_and_download_are_saved_before_ack(tmp_path, monkeypatch, bad):
    service = SRTService(tmp_path/'jobs.db', tmp_path/'output')
    monkeypatch.setattr(gateway, 'STORE', tmp_path/'gateway.db')
    monkeypatch.setattr(gateway, '_srt_inflight', set())
    data = b'{ "segments": [{"text":"Hello","start":0,"end":4}] }'
    source = service.import_bytes(data, 'original.json')
    jid = service.enqueue(source['id'], 'Create a downloadable SRT file.', 'auto', 1800,
                          method='file-srt', project_settings={'srt_output':'download-file'})['id']
    token=str(uuid4())
    path=tmp_path/'custom-downloads'/'flowkit-chatgpt'/token/'subtitles.srt'
    path.parent.mkdir(parents=True);path.write_bytes(b'<html>error</html>' if bad else SRT)
    notes='247 scenes. Audio tail is unverified.'
    calls=[]
    def handler(req):
        body=json.loads(req.content);calls.append(req.url.path)
        if req.url.path=='/commit':
            assert body['ok'] is (not bad)
            assert (service.output/jid/'response.txt').read_text()==notes
            assert (service.output/jid/'subtitles.srt').exists() is (not bad)
            if not bad:
                assert service.jobs()[0]['state']=='COMPLETED'
                assert (service.output/jid/'subtitles.srt').read_bytes()==SRT
            return httpx.Response(200,json={'ok':True})
        assert body['messages'][0]['content']=='Create a downloadable SRT file.'
        assert body['downloadSrt'] is True
        assert base64.b64decode(body['attachment']['base64'])==data
        return httpx.Response(200,json={'id':'remote','nativeDownload':{'token':token,'path':str(path)},
                                       'choices':[{'message':{'content':notes}}]})
    original=httpx.AsyncClient
    monkeypatch.setattr(httpx,'AsyncClient',lambda **kwargs:original(transport=httpx.MockTransport(handler),**kwargs))
    await service.process(service.jobs()[0])
    assert service.jobs()[0]['state']==('NEEDS_REVIEW' if bad else 'COMPLETED')
    assert path.exists()
    assert calls==['/v1/chat/completions','/commit']
