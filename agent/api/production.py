"""Read-only production progress, input checks and restart recovery guidance."""
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from agent.services import production_overview as production

router = APIRouter(prefix='/production', tags=['production'])


class Preflight(BaseModel):
    project_id: str = Field(min_length=1, max_length=100)
    video_id: str = Field(min_length=1, max_length=100)
    stage: Literal['elevenlabs', 'whisperx', 'srt', 'image_prompts', 'video_prompts', 'prompts', 'images', 'videos', 'assembly']
    source_id: str | None = Field(default=None, max_length=100)
    source_kind: Literal['elevenlabs', 'audio', 'whisperx', 'json', 'srt', 'asset'] | None = None
    segment_ids: list[str] = Field(default_factory=list, max_length=3000)
    text: str | None = Field(default=None, max_length=2000000)
    plan: dict | None = None
    provider: Literal['codex', 'claude', 'agy', 'chatgpt-web'] = 'chatgpt-web'
    direct_jobs: list[dict] | None = Field(default=None, max_length=200)
    device: Literal['cpu', 'cuda', 'auto'] | None = None


@router.get('/overview')
async def overview(project_id: str, video_id: str | None = None):
    return await production.overview(project_id, video_id)


@router.get('/recovery')
async def recovery(project_id: str, video_id: str | None = None):
    return await production.recovery(project_id, video_id)


@router.post('/preflight')
async def preflight(body: Preflight):
    return await production.preflight(body.model_dump())
