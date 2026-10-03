import importlib.util
import io
import json
from pathlib import Path
import pytest

spec=importlib.util.spec_from_file_location('wx_progress_runner',Path(__file__).resolve().parents[2]/'tools/whisperx/runner.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)

@pytest.fixture
def events(monkeypatch):
    result=[]
    monkeypatch.setattr(r,'event',lambda phase,message,**kw:result.append({'phase':phase,'message':message,**kw}))
    original=r.ProgressReporter.__init__
    monkeypatch.setattr(r.ProgressReporter,'__init__',lambda self,phase,message,**kw:original(self,phase,message,interval=0,**kw))
    return result


def test_native_asr_callback_and_audio_positions_preserve_result(events):
    expected={'language':'ja','segments':[{'text':'日本語','start':0,'end':15},{'text':'字幕','start':15,'end':30}]}
    class Model:
        def transcribe(self,audio,batch_size,progress_callback,verbose=False):
            assert batch_size==8 and audio is sentinel and verbose
            progress_callback(50)
            print('Transcript: [0.0 --> 15.0] 日本語')
            progress_callback(100)
            print('Transcript: [15.0 --> 30.0] 字幕')
            return expected
    sentinel=object()
    assert r.transcribe_with_progress(Model(),sentinel,8,30) is expected
    assert any(e.get('phase_percent')==50 for e in events)
    assert any(e.get('audio_done_seconds')==15 and e.get('segments_done')==1 for e in events)
    assert events[-1]['segments_total']==2
    assert events[-1]['audio_done_seconds']==30


def test_legacy_asr_parses_fragmented_native_progress(events):
    class Model:
        def transcribe(self,audio,batch_size,print_progress=False,verbose=False):
            assert print_progress and verbose
            r.sys.stdout.write('Progr');r.sys.stdout.write('ess: 25.00%...\n')
            print('Transcript: [0.0 --> 6.2] Example')
            return {'language':'en','segments':[{'start':0,'end':6.2,'text':'Example'}]}
    r.transcribe_with_progress(Model(),None,4,10)
    assert any(e.get('phase_percent')==25 for e in events)
    assert any(e.get('audio_done_seconds')==6.2 for e in events)


def test_alignment_observer_waits_until_second_pass_segment_finishes(events):
    segments=[{'text':'日本語','start':0,'end':3},{'text':'次 の文','start':4,'end':8}]
    expected={'segments':segments,'word_segments':[]}
    def legacy_align(transcript,model,metadata,audio,device,return_char_alignments=False):
        assert return_char_alignments
        for index, segment in enumerate(transcript):
            assert events[-1]['segments_done']==0  # text preprocessing is not alignment
        for index, segment in enumerate(transcript):
            assert segment is segments[index]
            assert events[-1]['segments_done']==index
            if index==0:
                continue  # upstream failed alignments are still processed segments
        return expected
    result=r.align_with_progress(legacy_align,segments,None,None,None,'cpu','ja',10)
    assert result is expected
    halfway=next(e for e in events if e.get('segments_done')==1)
    assert halfway['units_done']==3 and halfway['units_total']==6
    assert halfway['phase_percent']==50 and halfway['audio_done_seconds']==3
    assert halfway['unit']=='characters'
    assert events[-1]['segments_done']==2
    assert events[-1]['phase_percent']==100


def test_native_alignment_word_counts_and_unknown_implementations(events):
    segments=[{'text':'one two','start':0,'end':2},{'text':'three four five','start':3,'end':5}]
    def native(transcript,model,metadata,audio,device,return_char_alignments,progress_callback):
        assert transcript is segments
        progress_callback(50);progress_callback(100)
        return {'segments':transcript,'word_segments':[]}
    r.align_with_progress(native,segments,None,None,None,'cpu','en',8)
    assert any(e.get('units_done')==2 and e['units_total']==5 and e['unit']=='words' for e in events)
    events.clear()
    def unknown(transcript,model,metadata,audio,device,return_char_alignments):
        assert transcript is segments  # no wrapping when implementation is not recognized
        assert events[-1]['phase_percent'] is None
        return {'segments':transcript,'word_segments':[]}
    r.align_with_progress(unknown,segments,None,None,None,'cpu','en',8)
    assert [e['phase_percent'] for e in events]==[None,100]


def test_adapter_does_not_capture_structured_events_or_leak_stdout(monkeypatch):
    base=io.StringIO();monkeypatch.setattr(r.sys,'stdout',base)
    reporter=r.ProgressReporter('TRANSCRIBING','test',interval=0)
    with r.redirect_stdout(r.TranscriptionOutput(base,reporter,True)):
        print('Progress: 50.00%...')
        r.event('ALIGNING','next')
    lines=base.getvalue().splitlines()
    assert lines[0]=='Progress: 50.00%...'
    assert len([line for line in lines if line.startswith('FLOWKIT_WX ')])==2
    assert r.sys.stdout is base
