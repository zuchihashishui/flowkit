"""Read only named instruction files from the active video's prompts folder."""
from agent.services.output_paths import video_directory
from agent.services.video_files import destination


KINDS = ('image', 'video_4s', 'video_6s', 'video_8s', 'video_10s')
MAX_CHARACTERS = 97000


def discover(context, saved):
    result = {'directory': '', 'templates': {}, 'warnings': []}
    try:
        root = video_directory(context)
        if root is None:
            return result
        directory = destination(root, 'prompts')
        directory.mkdir(parents=True, exist_ok=True)
        result['directory'] = str(directory)
    except (OSError, ValueError) as exc:
        result['warnings'].append('Cannot read prompt instructions folder: ' + str(exc))
        return result
    for kind in KINDS:
        # Explicit manual edits/removals always win over files on disk.
        if kind in saved and saved[kind].source != 'folder':
            continue
        names = [f'prompt_instructions_{kind}.txt']
        if kind == 'video_10s':
            names.append('prompt_instructions_video-10s.txt')
        if kind in saved:
            # Keep an empty folder binding so legacy image instructions cannot
            # become an accidental fallback when a file disappears.
            result['templates'][kind] = {'name': names[0], 'text': '', 'source': 'folder'}
        try:
            paths = [destination(root, 'prompts/' + name) for name in names]
            path = next((p for p in paths if p.exists()), None)
            if path is None:
                if kind in saved:
                    result['warnings'].append(f'{names[0]}: auto-loaded file is missing.')
                continue
            # Bound the read even if a file is replaced after it is opened.
            with path.open('rb') as handle:
                raw = handle.read(MAX_CHARACTERS * 4 + 4)
            text = raw.decode('utf-8-sig')
            if not text.strip() or len(text) > MAX_CHARACTERS:
                raise ValueError('TXT must contain 1–97,000 characters.')
            result['templates'][kind] = {'name': path.name, 'text': text, 'source': 'folder'}
        except (OSError, ValueError) as exc:
            result['warnings'].append(f'{names[0]}: {exc}')
    return result
