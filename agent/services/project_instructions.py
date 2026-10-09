"""Project-wide UTF-8 instruction files. File edits are read for new requests."""
import hashlib
import json
import os
import uuid
from pydantic import BaseModel, Field, field_validator, ConfigDict
from agent.services.video_files import child, destination

NAMES = {
    'image': 'template_image_prompt.txt',
    'video_4s': 'template_video_4s_prompt.txt',
    'video_6s': 'template_video_6s_prompt.txt',
    'video_8s': 'template_video_8s_prompt.txt',
    'video_10s': 'template_video_10s_prompt.txt',
    'zip_file': 'template_zip_file_prompt.txt',
    'json_to_srt': 'template_json_to_srt_prompt.txt',
}
LEGACY_NAMES = {'zip_file': 'template_zip_file.txt', 'json_to_srt': 'template_json_to_srt.txt'}
MAX_CHARACTERS = 97000
DEFAULT_SRT = 'Convert the attached transcript JSON into a complete UTF-8 .srt file. Create the actual file and return its download link, not intermediate boundary JSON.\n\nEach cue represents one image scene. Preserve the original language and all spoken words in order. Use the real timestamps in units, segments[].words or word_segments; do not duplicate parallel word lists or invent timing. For Japanese or Chinese, combine characters into complete clauses and ideas.\n\nPrefer natural scenes lasting 3–15 seconds. Start at 00:00:00,000; each cue ends where the next starts. Use confirmed audio duration for the final end, or the largest transcript end if duration is unavailable, and explain that limitation outside the file. Preserve content and real timing if all constraints cannot be met, and report exceptions separately.\n\nUse consecutive numbering and HH:MM:SS,mmm --> HH:MM:SS,mmm timestamps. Separate cues with a blank line. Return the downloadable .srt file plus cue count, end time, shortest/longest duration and any exceptions. Do not return scene_end_unit_ids in place of the SRT file.'
DEFAULT_ZIP = '\n\n==================================================\nQUY TẮC XỬ LÝ NHÓM DÒNG SRT\n\nMỗi tin nhắn gồm từ 1 đến {batch_size} dòng, dạng NNN nội dung. NNN là số dòng gốc,\nkhông phải số thứ tự để đánh lại từ đầu. Tạo một prompt riêng đầy đủ cho MỖI dòng,\náp dụng các hướng dẫn thiết kế trong tài liệu này riêng cho từng dòng.\nKhông gộp các dòng thành một ảnh/prompt và không bỏ dòng nào.\n\nTạo MỘT file ZIP thực tế tên image_prompts.zip cho mỗi nhóm.\nBên trong ZIP chỉ có các file TXT UTF-8: 001.txt, 002.txt... theo số dòng gốc\ntrong tin nhắn hiện tại (ví dụ 010 → 010.txt). Mỗi TXT chứa toàn bộ prompt riêng\ncủa dòng đó theo hướng dẫn trong tài liệu, không gộp nhiều dòng vào một TXT.\nKhông đưa kết quả nhóm trước vào ZIP nhóm sau. Trả link tải ZIP đã tạo.\nQuy tắc này thay thế quy tắc mâu thuẫn về số lượng/cách xuất kết quả; giữ nguyên\ncác hướng dẫn về nội dung, phong cách và chất lượng.\n'


class InstructionUpdate(BaseModel):
    model_config = ConfigDict(extra='forbid')
    revision: str
    templates: dict[str, str]

    @field_validator('templates')
    @classmethod
    def valid_templates(cls, value):
        if set(value) != set(NAMES):
            raise ValueError('Save all seven project instruction templates.')
        if any(len(text) > MAX_CHARACTERS for text in value.values()):
            raise ValueError('Each instruction file must be at most 97,000 characters.')
        return value


def directory(project_id, name):
    from agent.services.video_files import ROOT
    folder = destination(child(ROOT, name, project_id), 'prompt_instructions')
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def read(project_id, name, legacy_srt=''):
    folder = directory(project_id, name)
    files, warnings, revision, configured = {}, [], hashlib.sha256(), False
    for kind, filename in NAMES.items():
        path = destination(folder, filename)
        if not path.exists() and kind in LEGACY_NAMES:
            path = destination(folder, LEGACY_NAMES[kind])
        raw = None
        text = DEFAULT_ZIP if kind == 'zip_file' else (legacy_srt or DEFAULT_SRT) if kind == 'json_to_srt' else ''
        try:
            if path.exists():
                configured = True
                with path.open('rb') as stream:
                    raw = stream.read(MAX_CHARACTERS * 4 + 4)
                text = raw.decode('utf-8-sig')
                if len(text) > MAX_CHARACTERS:
                    raise ValueError('File exceeds 97,000 characters.')
        except (OSError, ValueError) as exc:
            text = ''
            warnings.append(filename + ': ' + str(exc))
        revision.update(filename.encode() + b'\0' + (b'missing' if raw is None else raw) + b'\0')
        files[kind] = {'name': filename, 'text': text, 'source': 'project', 'exists': raw is not None}
    return {'directory': str(folder), 'templates': files, 'revision': revision.hexdigest(),
            'configured': configured, 'warnings': warnings}


def write(project_id, name, update):
    current = read(project_id, name)
    if update.revision != current['revision']:
        raise ValueError('Project instruction files changed. Reload project settings before saving.')
    folder = directory(project_id, name)
    originals, pending, replaced = {}, {}, []
    try:
        for kind, filename in NAMES.items():
            target = destination(folder, filename)
            originals[target] = target.read_bytes() if target.exists() else None
            temporary = destination(folder, filename + '.' + uuid.uuid4().hex + '.part')
            pending[target] = temporary
            temporary.write_text(update.templates[kind], encoding='utf-8')
        for target, temporary in pending.items():
            os.replace(temporary, target)
            replaced.append(target)
    except BaseException:
        for target in reversed(replaced):
            if originals[target] is None:
                target.unlink(missing_ok=True)
            else:
                target.write_bytes(originals[target])
        raise
    finally:
        for temporary in pending.values():
            temporary.unlink(missing_ok=True)
    return read(project_id, name)


def supports_zip(model):
    return (model or 'GPT-5.6 Sol').strip().casefold() == 'gpt-5.6 sol'
