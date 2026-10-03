import json
from copy import deepcopy

import pytest

from agent.services.transcript_split import split_transcript, write_split


def sample():
    words=[{'word':'日','start':99.5,'end':99.8,'score':.91},
           {'word':'本','start':99.8,'end':100.2,'score':.92},
           {'word':'語','start':100,'end':100.3,'score':.93},
           {'word':'です。','start':101,'end':102,'score':.94}]
    return {'language':'ja','schema_version':1,'metadata':{'time_unit':'seconds','audio_duration_seconds':110},
            'segments':[{'start':99.5,'end':102,'text':'日本語です。','words':deepcopy(words),
                         'chars':[{'char':c} for c in '日本語です。']}], 'word_segments':words}


def payload(source):
    return json.dumps(source,ensure_ascii=False).encode()


def text(part):
    return ''.join(s['text'] for s in part['segments'])


def test_crossing_word_stays_whole_exact_boundary_moves_to_image_without_resetting_timestamps():
    original=sample();before=deepcopy(original);parts=split_transcript(payload(original))
    assert text(parts['video'])=='日本' and text(parts['image'])=='語です。'
    assert parts['video']['word_segments']==original['word_segments'][:2]
    assert parts['image']['word_segments']==original['word_segments'][2:]
    assert parts['image']['segments'][0]['start']==100
    assert parts['video']['segments'][0]['end']==100.2
    assert parts['video']['segments'][0]['chars']+parts['image']['segments'][0]['chars']==original['segments'][0]['chars']
    assert parts['image']['metadata']['audio_duration_seconds']==110
    assert parts['image']['metadata']['transcript_split']['requested_range_seconds']=={'start':100,'end':110}
    assert any('crosses' in warning for warning in parts['video']['metadata']['transcript_split']['warnings'])
    assert original==before


@pytest.mark.parametrize('cut,video_words',[(0,0),(99.5,0),(99.8,1),(100,2),(100.001,3),(101,3),(110,4),(500,4)])
def test_threshold_boundaries_empty_halves_and_custom_value(cut,video_words):
    original=sample();parts=split_transcript(payload(original),cut)
    assert len(parts['video']['word_segments'])==video_words
    assert parts['video']['word_segments']+parts['image']['word_segments']==original['word_segments']
    assert text(parts['video'])+text(parts['image'])=='日本語です。'
    if not video_words:assert parts['video']['segments']==[]
    if video_words==4:assert parts['image']['segments']==[]


def test_missing_times_keep_every_word_and_explicit_warning():
    source=sample()
    words=[{'word':'日'},{'word':'本','start':99,'end':99.5},{'word':'語'}, {'word':'です。','start':101,'end':102}]
    source['word_segments']=deepcopy(words);source['segments'][0]['words']=deepcopy(words)
    parts=split_transcript(payload(source))
    assert text(parts['video'])=='日本語' and text(parts['image'])=='です。'
    assert parts['video']['word_segments']==words[:3]
    assert 'start' not in parts['video']['word_segments'][0]
    assert any('missing' in warning for warning in parts['image']['metadata']['transcript_split']['warnings'])


def test_flat_only_alignment_partitions_segment_text_and_preserves_punctuation_spaces():
    words=[{'word':'Hello','start':98,'end':99},{'word':'world','start':101,'end':103}]
    source={'segments':[{'text':'  Hello, world!  ','start':98,'end':103}], 'word_segments':words}
    parts=split_transcript(payload(source))
    assert text(parts['video'])=='  Hello, '
    assert text(parts['image'])=='world!  '
    assert parts['image']['segments'][0]['words']==words[1:]


def test_segment_without_alignment_is_retained_whole_with_warning():
    source={'segments':[{'text':'Unaligned text.','start':99,'end':104},{'text':'Next.','start':106,'end':110}], 'word_segments':[]}
    parts=split_transcript(payload(source))
    assert text(parts['video'])=='Unaligned text.' and text(parts['image'])=='Next.'
    assert any('whole' in w or 'complete' in w for w in parts['video']['metadata']['transcript_split']['warnings'])


def test_alignment_mismatch_preserves_text_and_words_without_silent_loss():
    source=sample();source['segments'][0]['text']='The text differs.'
    parts=split_transcript(payload(source))
    assert text(parts['video'])=='The text differs.' and text(parts['image'])==''
    assert parts['video']['word_segments']==source['word_segments']
    assert any('do not match' in w for w in parts['video']['metadata']['transcript_split']['warnings'])


def test_milliseconds_are_compared_correctly_and_kept_unchanged():
    source=sample();source['metadata']['time_unit']='milliseconds'
    for word in source['word_segments']:
        word['start']*=1000;word['end']*=1000
    source['segments'][0]['words']=deepcopy(source['word_segments'])
    parts=split_transcript(payload(source))
    assert text(parts['video'])=='日本'
    assert parts['image']['word_segments'][0]['start']==100000


def test_output_writes_leave_original_bytes_identical_and_resplit_without_audio(tmp_path):
    source=tmp_path/'transcript.json'
    original=b'\xef\xbb\xbf'+json.dumps(sample(),ensure_ascii=False,indent=4).encode()
    source.write_bytes(original)
    first=write_split(source,100)
    assert first['video_words']==2 and first['image_words']==2
    second=write_split(source,101)
    assert second['video_words']==3 and second['image_words']==1
    assert source.read_bytes()==original
    assert len(list(tmp_path.glob('*.json')))==3 and not list(tmp_path.glob('*.part'))


def test_long_japanese_transcript_keeps_all_10000_characters_and_native_records():
    chars=('日本語の映像制作。'*1200)[:10000]
    words=[{'word':c,'start':i*.2,'end':(i+1)*.2,'score':.9} for i,c in enumerate(chars)]
    source={'segments':[{'text':chars,'words':words,'start':0,'end':2000}], 'word_segments':deepcopy(words)}
    parts=split_transcript(payload(source),100)
    assert len(parts['video']['word_segments'])==500
    assert len(parts['image']['word_segments'])==9500
    assert parts['video']['word_segments']+parts['image']['word_segments']==words
    assert text(parts['video'])+text(parts['image'])==chars


@pytest.mark.parametrize('value',[-1,86401,float('inf'),float('nan'),True,'100'])
def test_invalid_cutoff_does_not_touch_original_or_existing_parts(tmp_path,value):
    source=tmp_path/'transcript.json';source.write_bytes(payload(sample()));write_split(source)
    before={p.name:p.read_bytes() for p in tmp_path.iterdir()}
    with pytest.raises(ValueError):write_split(source,value)
    assert {p.name:p.read_bytes() for p in tmp_path.iterdir()}==before
