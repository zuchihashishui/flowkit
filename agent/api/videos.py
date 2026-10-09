from fastapi import APIRouter, HTTPException
from agent.models.video import Video, VideoCreate, VideoUpdate
from agent.sdk.persistence.sqlite_repository import SQLiteRepository
from dataclasses import asdict

router = APIRouter(prefix="/videos", tags=["videos"])

_repo = SQLiteRepository()


def _video_to_flat(sdk_video) -> dict:
    """Convert SDK Video domain model to flat dict matching API response shape."""
    return {
        "id": sdk_video.id,
        "project_id": sdk_video.project_id,
        "title": sdk_video.title,
        "description": sdk_video.description,
        "display_order": sdk_video.display_order,
        "status": sdk_video.status,
        "orientation": sdk_video.orientation,
        "vertical_url": sdk_video.vertical_url,
        "horizontal_url": sdk_video.horizontal_url,
        "thumbnail_url": sdk_video.thumbnail_url,
        "duration": sdk_video.duration,
        "resolution": sdk_video.resolution,
        "youtube_id": sdk_video.youtube_id,
        "privacy": sdk_video.privacy,
        "tags": sdk_video.tags,
        "created_at": sdk_video.created_at,
        "updated_at": sdk_video.updated_at,
    }


@router.post("", response_model=Video)
async def create(body: VideoCreate):
    from agent.services.project_workspace import create as create_video
    return await create_video(body)


@router.get("", response_model=list[Video])
async def list_by_project(project_id: str):
    videos = await _repo.list_videos(project_id)
    return [_video_to_flat(v) for v in videos]


@router.get("/{vid}", response_model=Video)
async def get(vid: str):
    sdk_video = await _repo.get_video(vid)
    if not sdk_video:
        raise HTTPException(404, "Video not found")
    return _video_to_flat(sdk_video)


@router.patch("/{vid}", response_model=Video)
async def update(vid: str, body: VideoUpdate):
    row = await _repo.update("video", vid, **body.model_dump(exclude_unset=True))
    if not row:
        raise HTTPException(404, "Video not found")
    sdk_video = _repo._row_to_video(row)
    return _video_to_flat(sdk_video)


@router.delete("/{vid}")
async def delete(vid: str, cascade: bool = False):
    if cascade:
        from agent.services.workspace_delete import delete as delete_workspace
        return await delete_workspace(video_id=vid)
    from agent.db.schema import get_db
    from agent.api.desktop import connection
    db = await get_db()
    cursor = await db.execute('SELECT 1 FROM script_document WHERE video_id=? LIMIT 1', (vid,))
    if await cursor.fetchone() or await _repo.list_scenes(vid):
        raise HTTPException(409, 'This video contains a script or scenes. Only an empty video can be deleted.')
    with connection() as media:
        if media.execute("SELECT 1 FROM jobs WHERE json_extract(payload,'$.video_id')=? LIMIT 1", (vid,)).fetchone():
            raise HTTPException(409, 'This video owns media jobs. Keep the video to preserve its results.')
    from agent.services.workflow_scope import has_owned_resources
    if has_owned_resources(video_id=vid):
        raise HTTPException(409, 'This video owns saved sources or jobs. Keep the video to preserve their relationships.')
    if not await _repo.delete("video", vid):
        raise HTTPException(404, "Video not found")
    return {"ok": True}


from agent.services.production_settings import VideoSettingsBody


@router.get('/{vid}/settings')
async def read_settings(vid: str):
    from agent.services.production_settings import get
    return await get(vid)


@router.put('/{vid}/settings')
async def write_settings(vid: str, body: VideoSettingsBody):
    from agent.services.production_settings import save
    return await save(vid, body)
