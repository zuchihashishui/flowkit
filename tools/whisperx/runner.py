"""Standalone WhisperX process. Run with the dedicated WhisperX Python environment."""
import argparse
from contextlib import redirect_stdout
import gc
import importlib.metadata
import inspect
import json
import math
import os
from pathlib import Path
import re
import shutil
import sys
import time


def event(phase, message, **metrics):
    # Bypass a temporary stdout adapter so structured events are never re-parsed.
    output = getattr(sys.stdout, 'event_stream', sys.stdout)
    print('FLOWKIT_WX ' + json.dumps({'phase': phase, 'message': message, **metrics}), file=output, flush=True)


class ProgressReporter:
    def __init__(self, phase, message, interval=.4, **metrics):
        self.phase, self.message, self.metrics = phase, message, metrics
        self.interval, self.last = interval, 0

    def report(self, force=False, **values):
        self.metrics.update(values)
        now = time.monotonic()
        if force or now-self.last >= self.interval:
            event(self.phase, self.message, **self.metrics)
            self.last = now

    def percent(self, value):
        try:
            value = float(value)
        except (TypeError, ValueError):
            return
        if math.isfinite(value):
            self.report(phase_percent=min(100, max(0, value)))


class TranscriptionOutput:
    """Read native 3.7 progress without changing audio chunks, batching or results."""
    def __init__(self, output, reporter, parse_percent):
        self.event_stream, self.reporter, self.parse_percent = output, reporter, parse_percent
        self.pending, self.segments = '', 0

    def write(self, text):
        self.event_stream.write(text)
        self.pending += text
        while '\n' in self.pending or '\r' in self.pending:
            line, self.pending = re.split(r'[\r\n]', self.pending, maxsplit=1)
            if self.parse_percent:
                progress = re.match(r'^Progress:\s*([\d.]+)%', line)
                if progress:
                    self.reporter.percent(progress[1])
            segment = re.match(r'^Transcript:\s*\[[\d.]+\s*-->\s*([\d.]+)\]', line)
            if segment:
                self.segments += 1
                self.reporter.report(segments_done=self.segments, audio_done_seconds=float(segment[1]))
        # Logging must not accumulate an unbounded line from a dependency.
        self.pending = self.pending[-65536:]
        return len(text)

    def flush(self):
        self.event_stream.flush()

    def __getattr__(self, name):
        return getattr(self.event_stream, name)


class AlignmentSegments(list):
    """Observe completion of the second pass used by WhisperX 3.7 alignment.

    Pass one only prepares text. Resuming after yield in pass two means the
    preceding segment was processed, including upstream early-continue cases.
    """
    def __init__(self, segments, callback):
        super().__init__(segments)
        self.passes, self.callback = 0, callback

    def __iter__(self):
        self.passes += 1
        processing = self.passes == 2
        for index, segment in enumerate(super().__iter__(), 1):
            yield segment
            if processing:
                self.callback(index)


def transcribe_with_progress(model, audio, batch_size, duration):
    params = inspect.signature(model.transcribe).parameters
    reporter = ProgressReporter('TRANSCRIBING', 'Recognizing speech; progress follows completed speech chunks.', audio_seconds=duration)
    reporter.report(force=True, phase_percent=None, segments_done=0)
    kwargs = {'batch_size': batch_size}
    callback = 'progress_callback' in params
    if callback:
        kwargs['progress_callback'] = reporter.percent
    elif 'print_progress' in params:
        kwargs['print_progress'] = True
    if 'verbose' in params:
        kwargs['verbose'] = True
    with redirect_stdout(TranscriptionOutput(sys.stdout, reporter, not callback)):
        result = model.transcribe(audio, **kwargs)
    reporter.report(force=True, phase_percent=100, segments_done=len(result['segments']),
                    segments_total=len(result['segments']), audio_done_seconds=duration)
    return result


def align_with_progress(align, segments, model, metadata, audio, device, language, duration):
    counts = [0]
    for segment in segments:
        text = segment['text']
        counts.append(counts[-1] + (sum(not ch.isspace() for ch in text) if language in ('ja', 'zh') else len(text.split())))
    reporter = ProgressReporter('ALIGNING', 'Processing segments for word timestamps. Counts include segments with missing alignment.',
        segments_total=len(segments), units_total=counts[-1], unit='characters' if language in ('ja', 'zh') else 'words', audio_seconds=duration)
    reporter.report(force=True, phase_percent=None, segments_done=0, units_done=0, audio_done_seconds=0)
    def completed(count):
        count = max(0, min(len(segments), count))
        reporter.report(phase_percent=100*count/len(segments), segments_done=count, units_done=counts[count],
                        audio_done_seconds=segments[count-1]['end'] if count else 0)
    kwargs = {'return_char_alignments': True}
    params = inspect.signature(align).parameters
    if 'progress_callback' in params:
        def callback(percent):
            if isinstance(percent, (int, float)) and math.isfinite(percent):
                completed(round(percent*len(segments)/100))
        kwargs['progress_callback'] = callback
    else:
        # Only apply the observer to the verified two-pass implementation.
        # Other versions keep stage/elapsed reporting instead of a fake percent.
        try:
            source = inspect.getsource(align)
        except (OSError, TypeError):
            source = ''
        if source.count('enumerate(transcript)') == 2 and 'transcript = ' not in source:
            segments = AlignmentSegments(segments, completed)
    result = align(segments, model, metadata, audio, device, **kwargs)
    reporter.report(force=True, phase_percent=100, segments_done=len(segments), units_done=counts[-1], audio_done_seconds=duration)
    return result


def write_result(aligned, language, audio, options, target, duration=None):
    words = aligned.get('word_segments', [])
    untimed = sum(w.get('start') is None or w.get('end') is None for w in words)
    result = {**aligned, 'language': language, 'schema_version': 1,
              'metadata': {'engine': 'whisperx', 'version': importlib.metadata.version('whisperx'),
                           'source': Path(audio).name, 'time_unit': 'seconds',
                           **({'audio_duration_seconds': duration} if duration is not None else {}),
                           'options': options, 'untimed_words': untimed,
                           'timing_unit_note': 'WhisperX native units; Japanese/Chinese may be character-level.',
                           'warnings': ([f'{untimed} word units have no complete timing; none was invented.'] if untimed else [])}}
    target = Path(target)
    temporary = target.with_suffix('.tmp')
    temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    os.replace(temporary, target)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--request')
    args = parser.parse_args()
    if not args.check:
        event('STARTING', 'Loading Python, Torch and WhisperX')
    import torch
    import whisperx
    # Import the actual implementations, not just WhisperX's lazy public module.
    from whisperx.asr import load_model
    from whisperx.alignment import load_align_model, align
    if args.check:
        print('FLOWKIT_CHECK ' + json.dumps({'ok': True, 'python': sys.executable,
              'whisperx': importlib.metadata.version('whisperx'), 'torch': torch.__version__,
              'cuda_available': torch.cuda.is_available(), 'ffmpeg': shutil.which('ffmpeg'),
              'note': 'Imports only; models are downloaded and tested on first transcription.'}))
        return
    request = json.loads(Path(args.request).read_text(encoding='utf-8'))
    options = request['options']
    device = options.get('device', 'cuda')
    if device == 'auto':
        device = 'cuda' if torch.cuda.is_available() else 'cpu'
    if device == 'cuda' and not torch.cuda.is_available():
        raise RuntimeError('CUDA is unavailable in WHISPERX_PYTHON_BIN. Select CPU or install the CUDA environment.')
    if not shutil.which('ffmpeg'):
        raise RuntimeError('FFmpeg is missing from PATH. Install FFmpeg and restart Studio.')
    compute = 'float16' if device == 'cuda' else 'int8'
    event('LOADING_MODEL', f"Loading {options['model']} on {device}; the first run may download models.", device_used=device)
    model = load_model(options['model'], device, compute_type=compute,
                       language=options['language'] or None, vad_method='silero')
    event('READING_AUDIO', 'Decoding the complete merged audio')
    audio = whisperx.load_audio(request['audio'])
    from whisperx.audio import SAMPLE_RATE
    duration = len(audio) / SAMPLE_RATE
    transcript = transcribe_with_progress(model, audio, options['batch_size'], duration)
    language = transcript['language']
    del model
    gc.collect()
    if device == 'cuda':
        torch.cuda.empty_cache()
    if transcript['segments']:
        event('LOADING_ALIGNMENT_MODEL', f'Loading the alignment model for {language}; first use may download files.', language=language)
        model_a, metadata = load_align_model(language_code=language, device=device)
        aligned = align_with_progress(align, transcript['segments'], model_a, metadata, audio, device, language, duration)
    else:
        aligned = {'segments': [], 'word_segments': []}
    event('WRITING_JSON', 'Saving aligned words and segments', output_words=len(aligned.get('word_segments', [])), output_segments=len(aligned.get('segments', [])))
    write_result(aligned, language, request['audio'], {**options, 'device_used': device,
                 'compute_type': compute}, request['output'], duration=duration)
    event('COMPLETED', 'JSON saved', phase_percent=100)


if __name__ == '__main__':
    main()
