"""Verify exit statuses in separate pytest processes, not a mocked session."""
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest


@pytest.mark.parametrize('source,arguments,expected', [
    ('def test_ok():\n    assert True\n', [], 0),
    ('import pytest\n@pytest.mark.skip(reason="offline")\ndef test_skip():\n    pass\n', [], 5),
    ('', [], 5),
    ('def test_ok():\n    assert True\n', ['-k', 'absent'], 5),
    ('def test_failure():\n    assert False\n', [], 1),
    ('this is not valid python!', [], 2),
    ('', ['missing-directory'], 4),
])
def test_ci_exit_status(tmp_path, source, arguments, expected):
    shutil.copyfile(Path(__file__).parents[1] / 'conftest.py', tmp_path / 'conftest.py')
    (tmp_path / 'pytest.ini').write_text('[pytest]\n', encoding='utf-8')
    (tmp_path / 'test_sample.py').write_text(source, encoding='utf-8')
    env = {**os.environ, 'PYTEST_DISABLE_PLUGIN_AUTOLOAD': '1'}
    result = subprocess.run([sys.executable, '-m', 'pytest', '-q', '--require-tests', *arguments],
                            cwd=tmp_path, env=env, capture_output=True, text=True, timeout=20)
    assert result.returncode == expected, result.stdout + result.stderr
