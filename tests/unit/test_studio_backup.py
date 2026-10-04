import asyncio
import hashlib
import json
from pathlib import Path
import sqlite3
import stat
import subprocess
import sys
import uuid
import zipfile

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from agent.services import studio_backup as backup


def make_data(root):
    root.mkdir(exist_ok=True)
    db = sqlite3.connect(root / 'flow_agent.db')
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('CREATE TABLE project(id TEXT PRIMARY KEY,name TEXT,reference TEXT)')
    db.execute('CREATE TABLE concept_job(id TEXT PRIMARY KEY,state TEXT,payload TEXT)')
    audio = root / 'output' / 'elevenlabs' / 'test' / 'merged.mp3'
    audio.parent.mkdir(parents=True)
    audio.write_bytes(b'audio-content')
    db.execute('INSERT INTO project VALUES(?,?,?)', ('project', 'Keep WAL commit', str(audio)))
    db.execute('INSERT INTO concept_job VALUES(?,?,?)', ('job', 'COMPLETED', json.dumps({'audio_path': str(audio), 'prompt': 'Keep this text unchanged.'})))
    db.commit()
    return db, audio


def rewrite_zip(source, destination, transform):
    with zipfile.ZipFile(source) as src, zipfile.ZipFile(destination, 'w') as dst:
        for info in src.infolist():
            name, content = transform(info.filename, src.read(info.filename))
            dst.writestr(name, content)


def test_snapshot_includes_wal_rebases_paths_and_does_not_touch_live_data(tmp_path):
    live = tmp_path / 'live'
    db, audio = make_data(live)
    try:
        assert (live / 'flow_agent.db-wal').exists()
        result = backup.create_archive(live, True)
        target = tmp_path / 'restored'
        report = backup.restore_archive(live / 'backups' / result['filename'], target)
        assert report['include_media'] and report['rebased_paths'] == 2
        assert report['missing_media_paths'] == 0
        restored_audio = target / audio.relative_to(live)
        assert restored_audio.read_bytes() == b'audio-content'
        with sqlite3.connect(target / 'flow_agent.db') as restored:
            assert restored.execute('SELECT name,reference FROM project').fetchone() == ('Keep WAL commit', str(restored_audio))
            payload = json.loads(restored.execute('SELECT payload FROM concept_job').fetchone()[0])
            assert payload == {'audio_path': str(restored_audio), 'prompt': 'Keep this text unchanged.'}
        assert db.execute('SELECT reference FROM project').fetchone()[0] == str(audio)
        assert report['launch_env'] == {'FLOW_AGENT_DIR': str(target)}
    finally:
        db.close()


def test_metadata_only_snapshot_reports_missing_media_without_copying_secrets(tmp_path):
    live = tmp_path / 'live'
    db, audio = make_data(live)
    config = live / 'config'
    config.mkdir()
    (config / 'providers.json').write_text(json.dumps({'active': 'claude', 'api_key': 'secret', 'nested': {'token': 'secret', 'model': 'test'}}))
    (live / '.env').write_text('SECRET=not-in-backup')
    (live / 'secret.db').write_bytes(b'not-in-backup')
    try:
        result = backup.create_archive(live)
        target = tmp_path / 'restored'
        report = backup.restore_archive(live / 'backups' / result['filename'], target)
        assert report['missing_media_paths'] == 2
        assert not (target / 'output').exists()
        assert not (target / '.env').exists() and not (target / 'secret.db').exists()
        assert json.loads((target / 'config/providers.json').read_text()) == {'active': 'claude', 'nested': {'model': 'test'}}
    finally:
        db.close()


@pytest.mark.parametrize('state', ['QUEUED', 'RUNNING', 'SUBMITTING'])
def test_backup_refuses_pending_or_active_work(tmp_path, state):
    db, _ = make_data(tmp_path)
    try:
        db.execute('UPDATE concept_job SET state=?', (state,))
        db.commit()
        with pytest.raises(ValueError, match='Finish or cancel'):
            backup.create_archive(tmp_path)
        assert not list((tmp_path / 'backups').glob('*.zip'))
        assert not backup.is_backing_up()
    finally:
        db.close()


def test_backup_rejects_output_symlink(tmp_path):
    live = tmp_path / 'live'
    db, _ = make_data(live)
    external = tmp_path / 'outside'
    external.mkdir()
    (external / 'secret.txt').write_text('secret')
    (live / 'output' / 'link').symlink_to(external, target_is_directory=True)
    try:
        with pytest.raises(ValueError, match='symlinks'):
            backup.create_archive(live, True)
    finally:
        db.close()


def test_restore_checks_digest_and_never_overwrites_existing_directory(tmp_path):
    db, _ = make_data(tmp_path / 'live')
    try:
        result = backup.create_archive(tmp_path / 'live', True)
        archive = tmp_path / 'live/backups' / result['filename']
        existing = tmp_path / 'existing'
        existing.mkdir()
        (existing / 'keep').write_text('kept')
        with pytest.raises(ValueError, match='new directory'):
            backup.restore_archive(archive, existing)
        assert (existing / 'keep').read_text() == 'kept'
        corrupt = tmp_path / 'corrupt.zip'
        rewrite_zip(archive, corrupt, lambda name, value: (name, b'audio-changed' if name.endswith('merged.mp3') else value))
        with pytest.raises(ValueError, match='size|integrity'):
            backup.restore_archive(corrupt, tmp_path / 'new')
        assert not (tmp_path / 'new').exists()
        assert not list(tmp_path.glob('.flowkit-restore-*'))
    finally:
        db.close()


@pytest.mark.parametrize('entry', ['../outside', '/absolute', 'output/../../outside', r'output\..\outside', 'output/C:drive', 'output/CON', 'output/audio.'])
def test_restore_rejects_unsafe_names_before_extraction(tmp_path, entry):
    archive = tmp_path / 'unsafe.zip'
    with zipfile.ZipFile(archive, 'w') as stream:
        stream.writestr(entry, b'bad')
    with pytest.raises(ValueError):
        backup.restore_archive(archive, tmp_path / 'restored')
    assert not (tmp_path / 'restored').exists()


def test_restore_rejects_symlink_and_unlisted_payload(tmp_path):
    archive = tmp_path / 'link.zip'
    info = zipfile.ZipInfo('output/link')
    info.create_system = 3
    info.external_attr = (stat.S_IFLNK | 0o777) << 16
    with zipfile.ZipFile(archive, 'w') as stream:
        stream.writestr(info, '../outside')
    with pytest.raises(ValueError, match='Links'):
        backup.restore_archive(archive, tmp_path / 'restored')
    db, _ = make_data(tmp_path / 'live')
    try:
        result = backup.create_archive(tmp_path / 'live')
        archive = tmp_path / 'live/backups' / result['filename']
        with zipfile.ZipFile(archive, 'a') as stream:
            stream.writestr('output/unlisted.mp3', b'not in manifest')
        with pytest.raises(ValueError, match='manifest'):
            backup.restore_archive(archive, tmp_path / 'restored')
    finally:
        db.close()


def test_restore_rebases_windows_paths_inside_json(tmp_path):
    live = tmp_path / 'live'
    db, audio = make_data(live)
    try:
        old = r'C:\project\flowkit'
        db.execute('UPDATE project SET reference=?', (old + r'\output\elevenlabs\test\merged.mp3',))
        db.commit()
        result = backup.create_archive(live, True)
        original = live / 'backups' / result['filename']
        archive = tmp_path / 'windows.zip'
        def transform(name, content):
            if name == 'manifest.json':
                manifest = json.loads(content)
                manifest['source_root'] = old
                content = json.dumps(manifest).encode()
            return name, content
        rewrite_zip(original, archive, transform)
        target = tmp_path / 'restored'
        backup.restore_archive(archive, target)
        with sqlite3.connect(target / 'flow_agent.db') as restored:
            assert restored.execute('SELECT reference FROM project').fetchone()[0] == str(target / audio.relative_to(live))
    finally:
        db.close()


def test_restored_configuration_is_used_by_runtime_and_config_apis(tmp_path):
    import os
    root = Path(__file__).resolve().parents[2]
    config = tmp_path / 'config'
    config.mkdir()
    models = json.loads((root / 'agent/models.json').read_text())
    models['restored_marker'] = 'from backup'
    (config / 'models.json').write_text(json.dumps(models))
    (config / 'providers.json').write_text(json.dumps({'active': 'codex', 'roles': {}}))
    result = subprocess.run([sys.executable, '-c',
        'import json; from agent import config; from agent.api import models, providers; '
        'from agent.services import omni_flash; '
        'print(json.dumps({"models":str(config._MODELS_FILE),"providers":str(providers._PROVIDERS_FILE),'
        '"marker":models._read_models()["restored_marker"],"active":providers._read()["active"],'
        '"omni":str(omni_flash._MODELS_FILE)}))'],
        cwd=root, env={**os.environ, 'FLOW_AGENT_DIR': str(tmp_path)}, capture_output=True, text=True, check=True)
    restored = json.loads(result.stdout)
    assert restored == {'models': str(config / 'models.json'), 'providers': str(config / 'providers.json'),
                        'marker': 'from backup', 'active': 'codex', 'omni': str(config / 'models.json')}


@pytest_asyncio.fixture
async def project_data(tmp_path, monkeypatch):
    from agent.db import schema, crud
    await schema.close_db()
    monkeypatch.setattr(schema, 'DB_PATH', tmp_path / 'flow_agent.db')
    await schema.init_db()
    project = await crud.create_project(name='Original', language='ja', material='realistic', story='This video-specific content is not a template.')
    await crud.create_video(project_id=project['id'], title='Only original video')
    yield project
    await schema.close_db()


@pytest.mark.asyncio
async def test_duplicate_project_copies_configuration_but_no_videos_or_content(project_data):
    from agent.db import schema
    from agent.services import project_settings
    pid = project_data['id']
    settings = await project_settings.get(pid)
    settings['image_prompt_url'] = 'https://chatgpt.com/g/g-image-template'
    await project_settings.save(pid, project_settings.SettingsBody(**settings))
    result = await backup.duplicate_project(pid, 'Copy channel')
    copied = result['project']
    assert copied['id'] != pid and copied['name'] == 'Copy channel'
    assert copied['language'] == 'ja' and copied['story'] is None
    settings_copy = await project_settings.get(copied['id'])
    assert settings_copy['image_prompt_url'] == settings['image_prompt_url']
    assert settings_copy['google_flow_url'] == 'https://flow.google.com/project/' + pid
    db = await schema.get_db()
    assert (await (await db.execute('SELECT COUNT(*) FROM video WHERE project_id=?', (copied['id'],))).fetchone())[0] == 0
    settings_copy['image_prompt_url'] = 'https://chatgpt.com/g/g-other'
    await project_settings.save(copied['id'], project_settings.SettingsBody(**settings_copy))
    assert (await project_settings.get(pid))['image_prompt_url'] == settings['image_prompt_url']


@pytest.mark.asyncio
async def test_duplicate_keeps_explicit_remote_destination_and_settings_revision(project_data):
    from agent.services import project_settings
    remote = str(uuid.uuid4())
    settings = await project_settings.get(project_data['id'])
    settings['google_flow_url'] = 'https://flow.google.com/project/' + remote
    await project_settings.save(project_data['id'], project_settings.SettingsBody(**settings))
    result = await backup.duplicate_project(project_data['id'], 'New channel')
    assert result['google_flow_url'] == settings['google_flow_url']
    assert (await project_settings.get(result['project']['id']))['revision'] == 1


@pytest.mark.asyncio
async def test_backup_api_status_download_and_invalid_id(tmp_path, monkeypatch):
    from agent.api import maintenance
    monkeypatch.setattr(backup, 'BASE_DIR', tmp_path)
    monkeypatch.setattr(backup, '_jobs', {})
    db, _ = make_data(tmp_path)
    app = FastAPI()
    app.include_router(maintenance.router, prefix='/api')
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
            response = await client.post('/api/maintenance/backups', json={'include_media': True})
            assert response.status_code == 202
            bid = response.json()['id']
            if backup._tasks:
                await asyncio.gather(*backup._tasks)
            result = (await client.get('/api/maintenance/backups/' + bid)).json()
            assert result['state'] == 'COMPLETED'
            download = await client.get('/api/maintenance/backups/' + bid + '/file')
            assert download.status_code == 200 and download.content.startswith(b'PK')
            assert (await client.get('/api/maintenance/backups/not-a-uuid/file')).status_code == 404
    finally:
        db.close()
