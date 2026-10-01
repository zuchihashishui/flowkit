from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator
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
    except g.GatewayReviewRequired as e:
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
    if g._lock.locked():
        raise HTTPException(409, 'ChatGPT is busy. Wait for the current request to finish.')
    try:
        return {'response': await g.complete(body.prompt, body.model.strip() or 'auto')}
    except g.GatewayReviewRequired as e:
        raise HTTPException(409, str(e)) from e
