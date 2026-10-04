"""Project configuration copy and ID-addressed portable backups."""
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from agent.services import studio_backup

router = APIRouter(prefix='/maintenance', tags=['maintenance'])


class DuplicateProject(BaseModel):
    project_id: str = Field(min_length=1, max_length=100, pattern=r'^[a-zA-Z0-9_-]+$')
    name: str = Field(min_length=1, max_length=200)


class BackupOptions(BaseModel):
    include_media: bool = False


@router.post('/duplicate-project')
async def duplicate(body: DuplicateProject):
    try:
        return await studio_backup.duplicate_project(body.project_id, body.name)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.post('/backups', status_code=202)
async def backup(body: BackupOptions):
    try:
        return await studio_backup.start_backup(body.include_media)
    except ValueError as error:
        raise HTTPException(409, str(error)) from error


@router.get('/backups')
async def backups():
    return {'backups': studio_backup.list_backups(), 'busy': studio_backup.is_backing_up()}


@router.get('/backups/{bid}')
async def backup_status(bid: str):
    match = next((item for item in studio_backup.list_backups() if item['id'] == bid), None)
    if not match:
        raise HTTPException(404, 'Backup not found.')
    return match


@router.get('/backups/{bid}/file')
async def download_backup(bid: str):
    try:
        path = studio_backup.backup_file(bid)
    except (ValueError, FileNotFoundError) as error:
        raise HTTPException(404, str(error)) from error
    return FileResponse(path, media_type='application/zip', filename=path.name)
