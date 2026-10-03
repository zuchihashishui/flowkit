"""Partition saved WhisperX output without modifying the original JSON or times."""
from copy import deepcopy
import hashlib
import json
import math
from pathlib import Path

DEFAULT_VIDEO_SECONDS = 100
FILES = {'full': 'transcript.json', 'video': 'transcript_video.json',
         'image': 'transcript_image.json'}


def validate_seconds(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 86400:
        raise ValueError('Video duration must be a finite number from 0 to 86,400 seconds.')
    return value


def _time(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0 else None


def _cut(items, threshold, fallback=0):
    """Unknown times stay with the preceding side; leading unknowns follow next anchor."""
    anchors = [(i, _time(item.get('start'))) for i, item in enumerate(items)]
    anchors = [(i, start) for i, start in anchors if start is not None]
    if not anchors:
        return len(items) if fallback < threshold else 0
    # Leading unaligned records stay with the first timed record.
    if anchors[0][1] >= threshold:
        return 0
    return next((i for i, start in anchors if start >= threshold), len(items))


def _text_boundary(text, words, cut):
    """Find the exact source offset without rewriting punctuation/spacing."""
    indices = [i for i, char in enumerate(text) if not char.isspace()]
    compact = ''.join(text[i] for i in indices)
    cursor, offsets = 0, []
    for word in words:
        token = ''.join(c for c in word.get('word', '') if not c.isspace())
        if not token:
            offsets.append(offsets[-1] if offsets else 0)
            continue
        found = compact.find(token, cursor)
        if found < 0:
            return None
        offsets.append(indices[found])
        cursor = found + len(token)
    return offsets[cut]


def _segments_with_flat_alignment(segments, flat, warnings):
    if not flat or any(s.get('words') for s in segments):
        return segments
    prepared, cursor = [], 0
    for segment in segments:
        compact = ''.join(c for c in segment['text'] if not c.isspace())
        position, matched = 0, []
        while cursor < len(flat):
            token = ''.join(c for c in flat[cursor]['word'] if not c.isspace())
            found = compact.find(token, position) if token else position
            if found < 0:
                break
            matched.append(flat[cursor])
            position = found + len(token)
            cursor += 1
        prepared.append({**segment, 'words':matched} if matched else segment)
    if cursor != len(flat):
        warnings.append('Flat words could not all be matched to segment text. Segments without nested alignment stay whole.')
        return segments
    return prepared


def split_transcript(data, video_seconds=DEFAULT_VIDEO_SECONDS):
    video_seconds = validate_seconds(video_seconds)
    source = json.loads(data.decode('utf-8-sig'))
    if not isinstance(source, dict) or not isinstance(source.get('segments'), list) or not isinstance(source.get('word_segments'), list):
        raise ValueError('Expected WhisperX JSON with segments and word_segments arrays.')
    metadata = source.get('metadata') or {}
    if not isinstance(metadata, dict):
        raise ValueError('Transcript metadata must be an object.')
    unit = metadata.get('time_unit', source.get('time_unit', 'seconds'))
    if unit not in ('seconds','second','s','milliseconds','millisecond','ms'):
        raise ValueError('Unsupported transcript time unit.')
    scale = 1000 if unit in ('milliseconds','millisecond','ms') else 1
    threshold = video_seconds * scale
    warnings, sides, nested, left_nested = [], [[], []], [], []
    flat = source['word_segments']
    if any(not isinstance(w, dict) or not isinstance(w.get('word'), str) for w in flat):
        raise ValueError('word_segments must contain objects with string word fields.')
    if any(not isinstance(s, dict) or not isinstance(s.get('text'), str) for s in source['segments']):
        raise ValueError('Each segment must contain a text string.')
    segments = _segments_with_flat_alignment(source['segments'], flat, warnings)
    moved_to_image = False
    for index, original in enumerate(segments):
        if not isinstance(original, dict) or not isinstance(original.get('text'), str):
            raise ValueError('Each segment must contain a text string.')
        segment = deepcopy(original)
        words = segment.get('words') or []
        if not isinstance(words, list) or any(not isinstance(w, dict) or not isinstance(w.get('word'), str) for w in words):
            raise ValueError('Segment words must be objects with string word fields.')
        nested.extend(words)
        fallback = _time(segment.get('start'))
        if fallback is None:
            if not any(_time(w.get('start')) is not None for w in words):
                warnings.append(f'Segment {index+1}: no start timing is available; kept on the preceding side, defaulting to video before any timed segment.')
            fallback = threshold if moved_to_image else 0
        cut = _cut(words, threshold, fallback) if words else 0
        if moved_to_image:
            cut = 0
        if words and 0 < cut < len(words):
            offset = _text_boundary(segment['text'], words, cut)
            if offset is None:
                warnings.append(f'Segment {index+1}: words do not match source text; kept the whole segment on its starting side.')
                cut = len(words) if fallback < threshold else 0
            else:
                chars = segment.get('chars')
                char_cut = None
                if isinstance(chars, list):
                    char_text = ''.join(c.get('char', '') for c in chars)
                    if char_text == segment['text']:
                        length = 0
                        char_cut = 0
                        while char_cut < len(chars) and length < offset:
                            length += len(chars[char_cut].get('char', ''))
                            char_cut += 1
                    else:
                        char_cut = _cut(chars, _time(words[cut].get('start')) or threshold, fallback)
                        warnings.append(f'Segment {index+1}: character records could not be matched to text; partitioned by their existing start times.')
                for side, part_words, text in [(0, words[:cut], segment['text'][:offset]), (1, words[cut:], segment['text'][offset:])]:
                    part = {**segment, 'text':text, 'words':part_words}
                    if char_cut is not None:
                        part['chars'] = chars[:char_cut] if side == 0 else chars[char_cut:]
                    for key, choose in [('start', min), ('end', max)]:
                        values = [w[key] for w in part_words if _time(w.get(key)) is not None]
                        if values:
                            part[key] = choose(values)
                        else:
                            part.pop(key, None)
                    sides[side].append(part)
                left_nested.extend(words[:cut])
                moved_to_image = True
                continue
        if words:
            side = 0 if cut == len(words) else 1
            if side == 0:
                left_nested.extend(words)
        else:
            side = 1 if moved_to_image or fallback >= threshold else 0
            end = _time(segment.get('end'))
            if side == 0 and end is not None and end > threshold:
                warnings.append(f'Segment {index+1}: no word alignment at the split; kept the complete segment in video.')
        sides[side].append(segment)
        moved_to_image = moved_to_image or side == 1

    if nested == flat:
        flat_cut = len(left_nested)
    else:
        flat_cut = _cut(flat, threshold)
        if nested or flat:
            warnings.append('The flat word list differs from nested alignment. It is partitioned independently; segment text remains the source wording.')
    for words in (nested, flat if nested != flat else []):
        if any(_time(w.get('start')) is None for w in words):
            warnings.append('Some word starts are missing. Untimed words stay with the preceding side; leading untimed words follow the next timed word. No timestamp was invented.')
        if any(_time(w.get('start')) is not None and _time(w.get('end')) is not None and w['start'] < threshold < w['end'] for w in words):
            warnings.append('A word crosses the split time and is kept whole in video. Word/character timestamps are unchanged.')
        starts = [w['start'] for w in words if _time(w.get('start')) is not None]
        if any(b < a for a, b in zip(starts, starts[1:])):
            warnings.append('Source timestamps go backwards; original sequence is preserved and temporal partition may be approximate.')
    original_text = ''.join(s['text'] for s in source['segments'])
    if ''.join(s['text'] for side in sides for s in side) != original_text:
        raise ValueError('Transcript split did not preserve the complete source text.')
    total_duration = _time(metadata.get('audio_duration_seconds'))
    split_info = dict(version=1, video_duration_seconds=video_seconds, time_reference='original_audio',
                      timestamp_offset_seconds=0, boundary_policy='word_start; crossing words stay whole',
                      source_sha256=hashlib.sha256(data).hexdigest(), source_file='transcript.json',
                      warnings=list(dict.fromkeys(warnings)))
    results = {}
    for side, name, words in [(0, 'video', flat[:flat_cut]), (1, 'image', flat[flat_cut:])]:
        start = 0 if side == 0 else min(video_seconds, total_duration) if total_duration is not None else video_seconds
        end = min(video_seconds, total_duration) if side == 0 and total_duration is not None else video_seconds if side == 0 else total_duration
        results[name] = {**deepcopy(source), 'segments':sides[side], 'word_segments':deepcopy(words),
            'metadata':{**deepcopy(metadata), 'untimed_words':sum(_time(w.get('start')) is None or _time(w.get('end')) is None for w in words),
                        'transcript_split':{**split_info, 'part':name, 'requested_range_seconds':{'start':start,'end':end},
                                            'segment_count':len(sides[side]), 'word_count':len(words)}}}
    return results


def write_split(source_path, video_seconds=DEFAULT_VIDEO_SECONDS):
    """Compute both halves first, then replace derived files. Never write the source."""
    source_path = Path(source_path)
    parts = split_transcript(source_path.read_bytes(), video_seconds)
    pending = []
    try:
        for name, content in parts.items():
            target = source_path.parent / FILES[name]
            temporary = target.with_suffix('.json.part')
            pending.append((temporary, target))
            temporary.write_text(json.dumps(content, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
        for temporary, target in pending:
            temporary.replace(target)
    finally:
        for temporary, _ in pending:
            temporary.unlink(missing_ok=True)
    return {**parts['video']['metadata']['transcript_split'],
            'files':list(FILES.values()), 'video_words':len(parts['video']['word_segments']),
            'image_words':len(parts['image']['word_segments']),
            'video_segments':len(parts['video']['segments']), 'image_segments':len(parts['image']['segments'])}
