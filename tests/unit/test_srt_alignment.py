import json
import pytest
from agent.services.srt_alignment import prepare, compile_plan, attachment, instruction


def data(segments, duration=12, **extra):
    return json.dumps({'segments':segments, 'metadata':{'time_unit':'seconds', **({'audio_duration_seconds':duration} if duration is not None else {})}, **extra}, ensure_ascii=False).encode()


def answer(plan, ends):
    return json.dumps({'schema_version':1, 'source_sha256':plan['source_sha256'], 'scene_end_unit_ids':ends})


def japanese():
    return data([{'text':'日本語です。次の文。', 'words':[{'word':'日本語です。','start':0.2,'end':4.2}, {'word':'次の文。','start':5,'end':9.7}]}], duration=10)


def test_source_text_and_real_boundaries_make_continuous_srt():
    plan = prepare(japanese())
    srt, report = compile_plan(plan, answer(plan,[1,2]))
    assert srt == '1\n00:00:00,000 --> 00:00:05,000\n日本語です。\n\n2\n00:00:05,000 --> 00:00:10,000\n次の文。\n'
    assert report['status'] == 'PASSED'
    assert report['text_preserved'] and report['coverage_percent'] == 100
    assert report['shortest_ms'] == report['longest_ms'] == 5000
    assert 'original_text' not in attachment(plan)
    assert 'Do not rewrite' in instruction(plan)


@pytest.mark.parametrize('fence', ['json', 'srt', ''])
def test_code_block_from_existing_bridge_is_parsed_as_json_regardless_of_transport_label(fence):
    plan=prepare(japanese())
    response='```'+fence+'\n'+answer(plan,[1,2])+'\n```\n\nHere are the selected boundaries.'
    assert compile_plan(plan,response)[1]['status']=='PASSED'


def test_duplicate_flat_alignment_not_appended_and_punctuation_preserved():
    words=[{'word':'Hello','start':0,'end':1},{'word':'world','start':2,'end':4}]
    plan=prepare(data([{'text':'Hello, world!','words':words}], duration=5, word_segments=words))
    text,report=compile_plan(plan,answer(plan,[len(plan['units'])]))
    assert 'Hello, world!' in text and report['status']=='PASSED'
    assert report['source_units']==2
    assert any(i['code']=='DUPLICATE_ALIGNMENT_IGNORED' for i in report['issues'])


def test_missing_text_is_retained_with_diagnostics_not_silently_omitted():
    plan=prepare(data([{'text':'The blue sky.','words':[{'word':'blue','start':1,'end':2},{'word':'sky','start':3,'end':4}]}],duration=5))
    text,report=compile_plan(plan,answer(plan,[len(plan['units'])]))
    assert 'The blue sky.' in text
    assert report['status']=='REVIEW'
    assert report['missing_timing_units']==1
    assert any(i['code']=='TEXT_WITHOUT_ALIGNMENT' for i in report['issues'])


def test_word_mismatch_blocks_before_generation():
    plan=prepare(data([{'text':'Correct words.','words':[{'word':'Invented','start':0,'end':4}]}]))
    assert plan['report']['status']=='BLOCKED'
    with pytest.raises(ValueError,match='Fix source'):
        compile_plan(plan,answer(plan,[len(plan['units'])]))


@pytest.mark.parametrize('ends', [[1],[2,1,2],[0,2],[True,2],[],[3,2],['2']])
def test_bad_ids_never_drop_repeat_or_reorder_text(ends):
    plan=prepare(japanese())
    with pytest.raises(ValueError):compile_plan(plan,answer(plan,ends))


def test_response_hash_and_rewritten_text_are_rejected():
    plan=prepare(japanese());response=json.loads(answer(plan,[2]));response['source_sha256']='wrong'
    with pytest.raises(ValueError,match='snapshot'):compile_plan(plan,json.dumps(response))
    response=json.loads(answer(plan,[2]));response['text']='hallucinated'
    with pytest.raises(ValueError,match='only'):compile_plan(plan,json.dumps(response))


def test_untimed_boundary_rejected_but_complete_text_can_be_kept_in_one_cue():
    plan=prepare(data([{'text':'今日は晴れ。','words':[{'word':'今日は','start':0,'end':2},{'word':'晴れ。'}]}],duration=5))
    with pytest.raises(ValueError,match='missing'):compile_plan(plan,answer(plan,[1,2]))
    text,report=compile_plan(plan,answer(plan,[2]))
    assert '今日は晴れ。' in text and report['status']=='REVIEW'


def test_unknown_audio_tail_and_duration_override_are_explicit():
    raw=json.loads(japanese());raw['metadata'].pop('audio_duration_seconds');raw=json.dumps(raw).encode()
    plan=prepare(raw);text,report=compile_plan(plan,answer(plan,[2]))
    assert '00:00:09,700' in text
    assert report['status']=='REVIEW'
    assert any(i['code']=='AUDIO_DURATION_UNKNOWN' for i in report['issues'])
    longer=prepare(raw,10)
    assert longer['source_sha256']!=plan['source_sha256']
    assert compile_plan(longer,answer(longer,[2]))[1]['status']=='PASSED'
    assert prepare(raw,3)['report']['status']=='BLOCKED'


def test_short_audio_and_long_silence_are_reported_as_exceptions():
    short=prepare(data([{'text':'はい。','words':[{'word':'はい。','start':0.1,'end':1.1}]}],duration=1.5))
    report=compile_plan(short,answer(short,[1]))[1]
    assert report['duration_exception_count']==1 and report['status']=='REVIEW'
    long=prepare(data([{'text':'はい。','words':[{'word':'はい。','start':0.1,'end':1.1}]}],duration=40))
    assert compile_plan(long,answer(long,[1]))[1]['longest_ms']==40000


def test_explicit_milliseconds_and_out_of_order_timing():
    raw={'time_unit':'milliseconds','duration':6000,'segments':[{'text':'One. Two.','words':[{'word':'One.','start':100,'end':2000},{'word':'Two.','start':3000,'end':5000}]}]}
    plan=prepare(json.dumps(raw).encode())
    assert compile_plan(plan,answer(plan,[1,2]))[1]['status']=='PASSED'
    raw['segments'][0]['words'][1]['start']=50
    assert prepare(json.dumps(raw).encode())['report']['status']=='BLOCKED'


def test_large_japanese_transcript_keeps_all_10000_units_in_200_scenes():
    chars=('日本語の映像制作。'*1200)[:10000]
    words=[{'word':c,'start':i*.2,'end':(i+1)*.2} for i,c in enumerate(chars)]
    plan=prepare(data([{'text':chars,'words':words}],duration=len(chars)*.2))
    ends=list(range(50,len(words)+1,50))
    text,report=compile_plan(plan,answer(plan,ends))
    assert report['covered_units']==10000 and report['cue_count']==200
    assert report['text_preserved'] and report['status']=='PASSED'
    assert sum(s['duration_ms'] for s in report['scenes'])==2000000


@pytest.mark.parametrize('start', [float('nan'), float('inf'), -1, '5', True])
def test_invalid_numeric_timing_is_not_coerced(start):
    with pytest.raises(ValueError):prepare(data([{'text':'Word','words':[{'word':'Word','start':start,'end':6}]}]))
