"""Project production defaults with explicit, sparse per-video overrides.

A job receives resolved values at enqueue time. Changing these settings never
rewrites an existing job or its outputs.
"""
import json
from typing import Literal
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from agent.db.schema import get_db, _db_lock


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid')


class TTS(StrictModel):
    model: str = Field(default='Eleven v4', min_length=1, max_length=100)
    expected_voice: str = Field(default='', max_length=200)
    max_chunk_characters: int = Field(default=3000, ge=100, le=3000, strict=True)

    @field_validator('model', 'expected_voice')
    @classmethod
    def trim(cls, value, info):
        value = value.strip()
        if info.field_name == 'model' and not value:
            raise ValueError('TTS model cannot be empty.')
        return value


class WhisperX(StrictModel):
    model: Literal['tiny', 'base', 'small', 'medium', 'large-v2', 'large-v3'] = 'large-v3'
    device: Literal['auto', 'cpu', 'cuda'] = 'cuda'
    language: str = Field(default='', pattern=r'^([a-z]{2,3})?$')
    batch_size: int = Field(default=8, ge=1, le=32, strict=True)
    video_duration_seconds: float = Field(default=100, ge=0, le=86400, allow_inf_nan=False)


class Media(StrictModel):
    orientation: Literal['HORIZONTAL', 'VERTICAL'] = 'HORIZONTAL'
    image_model: str = Field(default='GEM_PIX_2', max_length=100)


class Assembly(StrictModel):
    size: Literal['1080p', '720p', 'vertical'] = '1080p'
    fps: Literal[24, 30, 60] = 30
    subtitles: Literal['burn', 'soft', 'off'] = 'off'
    fit: Literal['fit', 'crop'] = 'fit'
    font: str = Field(default='Yu Gothic', min_length=1, max_length=80, pattern=r'^[\w .-]+$')
    image_motion: Literal['none', 'zoom_in', 'zoom_out'] = 'none'


class SRT(StrictModel):
    instructions: str = Field(default='', max_length=50000)


class Production(StrictModel):
    tts: TTS = Field(default_factory=TTS)
    whisperx: WhisperX = Field(default_factory=WhisperX)
    media: Media = Field(default_factory=Media)
    assembly: Assembly = Field(default_factory=Assembly)
    srt: SRT = Field(default_factory=SRT)


DEFAULTS = Production().model_dump()


def merge(base, overrides):
    """Return an independent merged tree; never mutate stored defaults."""
    result = json.loads(json.dumps(base))
    for key, value in overrides.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = merge(result[key], value)
        else:
            result[key] = value
    return result


def validated_overrides(value):
    # Pydantic validates complete values, then keep only explicitly supplied keys.
    # This also rejects typos, nulls and unknown sections instead of ignoring them.
    validated = Production.model_validate(value).model_dump(exclude_unset=True)
    return {section: fields for section, fields in validated.items() if fields}


class VideoSettingsBody(StrictModel):
    revision: int = Field(default=0, ge=0, strict=True)
    overrides: dict = Field(default_factory=dict)

    @field_validator('overrides')
    @classmethod
    def partial_production(cls, value):
        return validated_overrides(value)


async def get(video_id, *, project=None):
    db = await get_db()
    video = await (await db.execute('SELECT project_id FROM video WHERE id=?', (video_id,))).fetchone()
    if not video:
        raise HTTPException(404, 'Video not found.')
    from agent.services.project_settings import get as project_settings
    if project is None:
        project = await project_settings(video['project_id'])
    row = await (await db.execute('SELECT value,revision FROM video_settings WHERE video_id=?', (video_id,))).fetchone()
    overrides = validated_overrides(json.loads(row['value'])) if row else {}
    inherited = project['production']
    effective = Production.model_validate(merge(inherited, overrides)).model_dump()
    shared = project.get('instruction_files', {})
    if shared.get('configured'):
        effective['srt']['instructions'] = shared['templates']['json_to_srt']['text']
    return {'video_id': video_id, 'project_id': video['project_id'],
            'revision': row['revision'] if row else 0, 'project_revision': project['revision'],
            'overrides': overrides, 'inherited': inherited, 'effective': effective}


async def save(video_id, body):
    async with _db_lock:
        current = await get(video_id)
        if body.revision != current['revision']:
            raise HTTPException(409, 'Video settings changed. Reload settings before saving.')
        db = await get_db()
        await db.execute('''INSERT INTO video_settings(video_id,value,revision) VALUES(?,?,?)
            ON CONFLICT(video_id) DO UPDATE SET value=excluded.value,revision=excluded.revision''',
            (video_id, json.dumps(body.overrides), body.revision + 1))
        await db.commit()
        return await get(video_id)


async def effective(ctx):
    if ctx.get('video_id'):
        values = await get(ctx['video_id'])
        if ctx.get('project_id') and values['project_id'] != ctx['project_id']:
            raise HTTPException(409, 'The selected video belongs to another project.')
        return values['effective']
    if ctx.get('project_id'):
        from agent.services.project_settings import get as project_settings
        return (await project_settings(ctx['project_id']))['production']
    return Production().model_dump()


async def apply_stage(body, section, ctx):
    """Resolve omitted API options; explicit request values always win.

    Return a validated copy of the caller's Pydantic model, so existing APIs can
    use their normal model_dump/enqueue code and freeze the result with the job.
    """
    resolved = (await effective(ctx))[section]
    inherited = {key: value for key, value in resolved.items()
                 if key in type(body).model_fields and key not in body.model_fields_set}
    return type(body).model_validate({**body.model_dump(), **inherited})
