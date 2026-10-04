from pydantic import BaseModel, StringConstraints
from typing import Optional, Annotated, Literal
from agent.models.enums import VideoStatus


VideoTitle = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class VideoCreate(BaseModel):
    project_id: str
    title: VideoTitle
    description: Optional[str] = None
    display_order: int = 0
    orientation: Optional[Literal["HORIZONTAL", "VERTICAL"]] = None


class VideoUpdate(BaseModel):
    title: Optional[VideoTitle] = None
    description: Optional[str] = None
    display_order: Optional[int] = None
    status: Optional[VideoStatus] = None
    orientation: Optional[Literal["HORIZONTAL", "VERTICAL"]] = None
    vertical_url: Optional[str] = None
    horizontal_url: Optional[str] = None
    thumbnail_url: Optional[str] = None
    duration: Optional[float] = None
    resolution: Optional[str] = None
    youtube_id: Optional[str] = None
    privacy: Optional[str] = None
    tags: Optional[str] = None


class Video(BaseModel):
    id: str
    project_id: str
    title: str
    description: Optional[str] = None
    display_order: int = 0
    status: str = "DRAFT"
    orientation: Optional[str] = None
    vertical_url: Optional[str] = None
    horizontal_url: Optional[str] = None
    thumbnail_url: Optional[str] = None
    duration: Optional[float] = None
    resolution: Optional[str] = None
    youtube_id: Optional[str] = None
    privacy: str = "unlisted"
    tags: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
