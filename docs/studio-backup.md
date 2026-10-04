# Project templates and portable backups

## Duplicate a project

`POST /api/maintenance/duplicate-project` with `{"project_id":"...","name":"New channel"}` creates a new **local** project and copies its reusable configuration, including Project Settings and production defaults. It does not copy videos, scenes, scripts, prompts, jobs or generated media, and it does not make a remote Google Flow request.

The duplicate initially uses the original project's Google Flow destination. If the original used the home URL and its local ID was also its remote Flow ID, duplication saves that ID in an explicit project URL. Change **Project Settings → Google Flow URL** to use a different remote project. Copies have independent settings and revisions.

## Create and export a backup

Finish or cancel queued and active work first. Review-required jobs may remain; their uncertainty is preserved. Studio temporarily blocks new mutations while copying data. A backup does not generate content or spend credits.

- **Configuration and database** includes project/video relations, settings, job history, prompts, subtitles stored in databases, and model/provider configuration. Generated and imported files are excluded.
- **Include media** also copies the `output` directory, including imported narration, transcripts, subtitles, downloaded media, render results and voice templates. This can be large and needs free disk space.

SQLite databases are captured with SQLite's backup API, including committed WAL writes. Each archive contains a file-size and SHA-256 manifest. Browser sessions, cookies, `.env`, credentials, application source, `node_modules`, Python environments and model caches are not included. Credential-shaped keys are removed from model/provider configuration snapshots.

API: `POST /api/maintenance/backups` with `{"include_media":true}` returns a backup ID. Poll `GET /api/maintenance/backups/{id}`, then download `GET /api/maintenance/backups/{id}/file`. `GET /api/maintenance/backups` lists backups. File-system paths cannot be supplied through these endpoints.

## Restore safely

Restore always creates a **new data directory**; it never overwrites the running Studio or merges databases. Select the archive and a parent folder in Studio, or run from the source directory using its Python environment:

```bash
python -m agent.services.studio_backup restore /path/backup.zip /path/new-flowkit-data
```

The destination must not already exist. All files are checked against the manifest before the new directory is made available. Symlinks, path traversal, duplicate paths, Windows device names, unsupported formats, checksum failures and insufficient disk space are rejected. Absolute paths under the original `output` directory are rewritten to the new directory in database fields, nested JSON and output JSON metadata. Files outside the original output directory are not copied or guessed.

The command prints JSON containing `directory`, `launch_env`, `include_media`, `rebased_paths` and `missing_media_paths`. The same information is saved to `restore-report.json`.

Desktop restore also shows startup commands and saves them as `START_RESTORED_STUDIO.txt` in the new folder. The commands retain `FLOW_AGENT_DIR` when starting Electron and its backend. Restored model/provider configuration lives under `config/`; the backend and configuration APIs use those files when present instead of changing the source checkout.

To use the restored data, stop Studio and its backend, then launch with `FLOW_AGENT_DIR` pointing to the restored folder. On Windows Command Prompt:

```bat
set "FLOW_AGENT_DIR=D:\FlowkitData\restored"
start_desktop.bat
```

On Linux/macOS:

```bash
FLOW_AGENT_DIR=/path/new-flowkit-data python -m uvicorn agent.main:app --host 127.0.0.1 --port 8100
```

Browser extensions and external models still need their normal setup on a new computer. A database-only restore retains file references but reports omitted files as missing; use a media-inclusive backup to transfer the complete local production workspace.

## Offline export

With Studio stopped or idle:

```bash
python -m agent.services.studio_backup backup --data-dir /path/flowkit-data --output /path/new-backup.zip --include-media
```

The output ZIP must not already exist. Remove `--include-media` for a smaller database/configuration snapshot.
