"""Read-only production progress, input checks and restart recovery guidance."""
import logging
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from agent.services import production_overview as production

logger = logging.getLogger(__name__)

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
    try:
        return await production.preflight(body.model_dump())
    except HTTPException:
        raise
    except Exception as error:
        logger.exception('Production preflight failed: stage=%s project=%s video=%s',
                         body.stage, body.project_id, body.video_id)
        detail = f'{type(error).__name__}: {str(error) or "No error message"}'
        raise HTTPException(500, f'{body.stage} preflight failed — {detail}. See backend.log for the full traceback.') from error
