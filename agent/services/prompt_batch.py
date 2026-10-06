"""Validate downloaded prompt archives without extracting untrusted paths."""
import io
import re
import zipfile
from pathlib import Path, PurePosixPath
from agent.config import OUTPUT_DIR
from agent.services.concept_writer import Concept

ARCHIVE_DIR = OUTPUT_DIR / 'text_prompts'
UUID_PATTERN = r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}'


def session_folder(session_id):
    if not isinstance(session_id, str) or not re.fullmatch(UUID_PATTERN, session_id):
        raise ValueError('Invalid prompt run identifier.')
    return ARCHIVE_DIR / session_id


def read_and_save_zip(native, payloads):
    session = payloads[0].get('text_session_id') if payloads else None
    folder = session_folder(session)
    if any(p.get('text_session_id') != session for p in payloads):
        raise ValueError('Prompt ZIP rows must belong to the same run.')
    if not isinstance(native, dict):
        raise ValueError('No downloaded prompt ZIP was returned. Check the Work tab.')
    token = str(native.get('token', ''))
    if not re.fullmatch(UUID_PATTERN, token):
        raise ValueError('Invalid ZIP download identifier.')
    path = Path(native.get('path', ''))
    if not path.is_absolute() or path.parts[-3:] != ('flowkit-chatgpt', token, 'prompts.zip') or path.resolve() != path or not path.is_file():
        raise ValueError('Downloaded ZIP is unavailable at the browser location.')
    if path.stat().st_size > 5 * 1024 * 1024:
        raise ValueError('Prompt ZIP exceeds 5 MiB.')
    raw = path.read_bytes()
    expected = {p['ordinal']:p for p in payloads}
    records = {}
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        entries = archive.infolist()
        if len(entries) > 20:
            raise ValueError('Unexpected files in prompt ZIP.')
        for entry in entries:
            name = PurePosixPath(entry.filename)
            if name.is_absolute() or '..' in name.parts or '\\' in entry.filename or ':' in entry.filename:
                raise ValueError('Unsafe path in prompt ZIP.')
            if entry.is_dir():
                continue
            match = re.fullmatch(r'(\d+)\.txt', name.name, re.IGNORECASE)
            if not match or entry.file_size > 200000 or entry.flag_bits & 1:
                raise ValueError('ZIP must contain only numbered UTF-8 TXT files, up to 200 KB each.')
            row = int(match[1])
            if row not in expected or row in records:
                raise ValueError('ZIP has duplicate or unexpected row numbers. No rows were assigned.')
            content = archive.read(entry).decode('utf-8-sig').strip()
            if not content or '\x00' in content:
                raise ValueError('ZIP contains an empty or invalid TXT file.')
            records[row] = content
    if set(records) != set(expected):
        raise ValueError('ZIP is missing requested rows. No rows were assigned.')
    concepts = {}
    for row, payload in expected.items():
        target = payload['prompt_kind']
        concepts[row] = Concept(title=payload['text'][:150] or 'Scene prompt', description=payload['text'][:3000],
                               **{target+'_prompt':records[row], ('video' if target=='image' else 'image')+'_prompt':payload.get('retained_prompt','')})
    # Every batch in this run shares one TXT folder. Retain each source ZIP
    # separately, so subsequent groups cannot overwrite earlier downloads.
    archives = folder / 'zips'
    archives.mkdir(parents=True, exist_ok=True)
    part = archives / f'{token}.zip.part'
    part.write_bytes(raw); part.replace(archives / f'{token}.zip')
    for row, text in records.items():
        part = folder / f'{row:03d}.txt.part'
        part.write_text(text, encoding='utf-8'); part.replace(folder / f'{row:03d}.txt')
    return concepts
