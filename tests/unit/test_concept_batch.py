import zipfile
import pytest
from agent.services.concept_writer import batch_message
from agent.services import prompt_batch

SESSION = '22222222-2222-2222-2222-222222222222'


def payloads(rows=(1,3,10)):
    return [dict(ordinal=row,text=f'日本語 {row}\nSecond line.',prompt_kind='image',retained_prompt='Saved video',text_session_id=SESSION) for row in rows]


def test_numbered_input_keeps_source_ids():
    assert batch_message(payloads())=='001 日本語 1 Second line.\n\n003 日本語 3 Second line.\n\n010 日本語 10 Second line.'
    for rows in [(),(1,1),tuple(range(1,7))]:
        with pytest.raises(ValueError):batch_message(payloads(rows))


def native_zip(tmp_path,entries):
    token='11111111-1111-1111-1111-111111111111'
    path=tmp_path/'flowkit-chatgpt'/token/'prompts.zip';path.parent.mkdir(parents=True)
    with zipfile.ZipFile(path,'w') as archive:
        for name,text in entries:archive.writestr(name,text)
    return dict(path=str(path),token=token)


def test_zip_maps_original_numbers_preserves_unicode_and_saves_files(tmp_path,monkeypatch):
    monkeypatch.setattr(prompt_batch,'ARCHIVE_DIR',tmp_path/'saved')
    native=native_zip(tmp_path,[('10.txt','日本語 10'),('001.txt','Full prompt\n'+('x'*6000)),('folder/3.txt','日本語 3')])
    result=prompt_batch.read_and_save_zip(native,payloads())
    assert result[10].image_prompt=='日本語 10' and result[10].video_prompt=='Saved video'
    assert len(result[1].image_prompt)>6000
    folder=tmp_path/'saved'/SESSION
    assert (folder/'zips'/f"{native['token']}.zip").is_file()
    assert (folder/'003.txt').read_text()=='日本語 3'


@pytest.mark.parametrize('entries',[
    [('1.txt','Missing two rows')],
    [('1.txt','A'),('001.txt','Duplicate'),('3.txt','B'),('10.txt','C')],
    [('1.txt','A'),('3.txt','B'),('11.txt','Wrong number')],
    [('../1.txt','Escape'),('3.txt','B'),('10.txt','C')],
    [('/1.txt','Absolute'),('3.txt','B'),('10.txt','C')],
    [('1.txt','A'),('3.txt',''),('10.txt','C')],
    [('1.txt','A'),('3.txt',b'\xff'),('10.txt','C')],
    [('1.txt','A'),('3.txt','B'),('10.txt','C'),('readme.md','Extra')],
    [('1.txt','A'),('3.txt','B'*200001),('10.txt','C')],
])
def test_bad_zip_never_saves_or_assigns_partial_results(tmp_path,monkeypatch,entries):
    monkeypatch.setattr(prompt_batch,'ARCHIVE_DIR',tmp_path/'saved')
    with pytest.raises((ValueError,UnicodeError)):
        prompt_batch.read_and_save_zip(native_zip(tmp_path,entries),payloads())
    assert not (tmp_path/'saved').exists()


def test_wrong_download_path_is_rejected(tmp_path):
    with pytest.raises(ValueError):prompt_batch.read_and_save_zip({'token':'11111111-1111-1111-1111-111111111111','path':str(tmp_path/'other.zip')},payloads())


@pytest.mark.parametrize('session', [None, '', '../outside', '/absolute', 'another-session'])
def test_invalid_run_folder_is_rejected_without_writing(tmp_path, monkeypatch, session):
    monkeypatch.setattr(prompt_batch, 'ARCHIVE_DIR', tmp_path/'saved')
    rows=payloads((1,));rows[0]['text_session_id']=session
    with pytest.raises(ValueError, match='run identifier'):
        prompt_batch.read_and_save_zip(native_zip(tmp_path,[('1.txt','Prompt')]), rows)
    assert not (tmp_path/'saved').exists()


def test_new_run_keeps_prior_files_and_mixed_runs_are_rejected(tmp_path, monkeypatch):
    monkeypatch.setattr(prompt_batch, 'ARCHIVE_DIR', tmp_path/'saved')
    first=native_zip(tmp_path/'first',[('1.txt','First run')])
    prompt_batch.read_and_save_zip(first,payloads((1,)))
    rows=payloads((1,));other='33333333-3333-3333-3333-333333333333';rows[0]['text_session_id']=other
    second=native_zip(tmp_path/'second',[('1.txt','Second run')])
    prompt_batch.read_and_save_zip(second,rows)
    assert (tmp_path/'saved'/SESSION/'001.txt').read_text()=='First run'
    assert (tmp_path/'saved'/other/'001.txt').read_text()=='Second run'
    with pytest.raises(ValueError,match='same run'):
        prompt_batch.read_and_save_zip(second,rows+payloads((2,)))
