"""Resolve npm CLI launchers on Windows without routing prompts through cmd.exe."""
import shutil
from pathlib import Path


def windows_cli_args(args):
    executable = shutil.which(args[0])
    if not executable:
        raise RuntimeError(f'{args[0]} is not installed or not on PATH')
    if Path(executable).suffix.lower() not in ('.cmd', '.bat'):
        return (executable, *args[1:])
    scripts = {'codex': '@openai/codex/bin/codex.js', 'claude': '@anthropic-ai/claude-code/cli.js'}
    entry = scripts.get(args[0])
    script = Path(executable).parent / 'node_modules' / entry if entry else None
    node = shutil.which('node')
    if not node or not script or not script.is_file():
        raise RuntimeError(f'Cannot launch {args[0]} through its Windows wrapper. Install its native executable or the standard global npm package with Node.js on PATH.')
    return (node, str(script), *args[1:])
