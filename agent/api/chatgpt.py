from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator
from typing import Annotated
from agent.services import chatgpt_gateway as g
router = APIRouter(prefix='/chatgpt', tags=['chatgpt'])

@router.get('/status')
async def status():
    return await g.status()

@router.get('/history')
async def history():
    return {'requests': g.audit_rows()}

@router.post('/test')
async def test():
    try:
        return {'response': await g.complete('Reply with exactly: Flowkit connection OK')}
    except (g.GatewayReviewRequired, g.GatewayBusy) as e:
        raise HTTPException(409, str(e)) from e

@router.post('/resume')
async def resume():
    try:
        return await g.reset()
    except Exception as e:
        raise HTTPException(409, str(e)) from e


class MessageBody(BaseModel):
    prompt: str = Field(min_length=1, max_length=20000)
    model: str = Field(default='auto', max_length=100)

    @field_validator('prompt')
    @classmethod
    def nonempty_prompt(cls, value):
        if not value.strip():
            raise ValueError('Enter a prompt')
        return value


@router.post('/message')
async def message(body: MessageBody):
    try:
        return {'response': await g.complete(body.prompt, body.model.strip() or 'auto')}
    except (g.GatewayReviewRequired, g.GatewayBusy) as e:
        raise HTTPException(409, str(e)) from e


class QueueBody(BaseModel):
    prompts: list[Annotated[str, Field(min_length=1, max_length=20000)]] = Field(min_length=1, max_length=200)
    model: str = Field(default='auto', max_length=100)

    @field_validator('prompts')
    @classmethod
    def nonempty(cls, values):
        if any(not v.strip() for v in values):
            raise ValueError('Every prompt must contain text')
        return values

class QueueIds(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=200)

class ConfigBody(BaseModel):
    workers: int = Field(ge=1, le=3)
    timeout_seconds: int = Field(ge=30, le=600)
    temporary: bool = True
    paused: bool = False

@router.get('/queue')
async def queue():
    return {'jobs':g.queue_rows(),'settings':g.settings()}

@router.post('/queue')
async def enqueue(body: QueueBody):
    return g.enqueue(body.prompts,body.model.strip() or 'auto')

@router.post('/cancel')
async def cancel(body: QueueIds):
    return g.cancel_jobs(body.ids)

@router.post('/retry')
async def retry(body: QueueIds):
    return g.retry_jobs(body.ids)

@router.post('/config')
async def config(body: ConfigBody):
    if g._inflight and body.workers != g.settings()['workers']:
        raise HTTPException(409,'Wait for active requests before changing worker count')
    return g.update_settings(body.model_dump())

class InspectionBody(BaseModel):
    model: str = Field(default='auto', max_length=100)

@router.post('/preflight')
async def preflight(body: InspectionBody):
    try:
        return await g.inspect_tabs('preflight', body.model.strip() or 'auto')
    except Exception as e:
        raise HTTPException(409, str(e)) from e

@router.post('/models')
async def models():
    try:
        return await g.inspect_tabs('discoverModels')
    except Exception as e:
        raise HTTPException(409, str(e)) from e
