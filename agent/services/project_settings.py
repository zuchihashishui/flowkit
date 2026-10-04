"""Project-owned browser destinations, frozen with each production request."""
import json
import re
from urllib.parse import urlsplit, urlunsplit
from contextvars import ContextVar
from pydantic import BaseModel, Field, field_validator
from fastapi import HTTPException
from agent.db.schema import get_db, _db_lock

DEFAULTS = {'chatgpt_url':'https://chatgpt.com/', 'image_prompt_url':'https://chatgpt.com/',
            'video_prompt_url':'https://chatgpt.com/',
            'elevenlabs_url':'https://elevenlabs.io/app/speech-synthesis/text-to-speech',
            'google_flow_url':'https://flow.google.com/'}
flow_page_url=ContextVar('flow_page_url',default=None)


def validate_url(key, value):
    value=value.strip()
    if len(value)>2000 or any(c.isspace() for c in value):
        raise ValueError('Enter a valid service URL without spaces.')
    u=urlsplit(value)
    if u.scheme!='https' or u.username or u.password or u.port not in (None,443) or u.fragment:
        raise ValueError('Use an HTTPS service URL without credentials or a fragment.')
    path=u.path.rstrip('/') or '/'
    if key in {'chatgpt_url','image_prompt_url','video_prompt_url'}:
        valid=u.hostname=='chatgpt.com' and (path=='/' or re.fullmatch(r'/g/g-[A-Za-z0-9_-]+',path))
        if key=='chatgpt_url' and path!='/':
            raise ValueError('Use the ChatGPT home URL for JSON → SRT. Put GPT links in Image/Video prompt URL.')
    elif key=='elevenlabs_url':
        valid=u.hostname=='elevenlabs.io' and path=='/app/speech-synthesis/text-to-speech'
    else:
        valid=(u.hostname=='flow.google.com' and (path=='/' or re.fullmatch(r'/project/[0-9a-fA-F-]{36}',path))) or (u.hostname=='labs.google' and re.fullmatch(r'/fx/(?:[a-z]{2}/)?tools/flow(?:/project/[0-9a-fA-F-]{36})?',path))
    if not valid:
        raise ValueError('URL must point to the supported service page or GPT home, not an existing conversation.')
    return urlunsplit(('https',u.hostname,path,u.query,''))


class URLs(BaseModel):
    chatgpt_url: str=DEFAULTS['chatgpt_url']
    image_prompt_url: str=DEFAULTS['image_prompt_url']
    video_prompt_url: str=DEFAULTS['video_prompt_url']
    elevenlabs_url: str=DEFAULTS['elevenlabs_url']
    google_flow_url: str=DEFAULTS['google_flow_url']

    @field_validator('chatgpt_url','image_prompt_url','video_prompt_url','elevenlabs_url','google_flow_url')
    @classmethod
    def service_url(cls,value,info):
        return validate_url(info.field_name,value)


class SettingsBody(URLs):
    revision: int=Field(default=0,ge=0)


async def get(project_id):
    db=await get_db()
    project=await (await db.execute("SELECT id FROM project WHERE id=? AND status!='DELETED'",(project_id,))).fetchone()
    if not project:raise HTTPException(404,'Project not found.')
    row=await (await db.execute('SELECT value,revision FROM project_settings WHERE project_id=?',(project_id,))).fetchone()
    return {**DEFAULTS,**(json.loads(row['value']) if row else {}),'revision':row['revision'] if row else 0}


async def save(project_id,body):
    async with _db_lock:
        current=await get(project_id)
        if current['revision']!=body.revision:raise HTTPException(409,'Project settings changed. Reload settings before saving.')
        data=body.model_dump(exclude={'revision'})
        db=await get_db()
        await db.execute('INSERT INTO project_settings(project_id,value,revision) VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET value=excluded.value,revision=excluded.revision',
                         (project_id,json.dumps(data),body.revision+1))
        await db.commit()
        return {**data,'revision':body.revision+1}


async def snapshot(ctx):
    return await get(ctx['project_id']) if ctx.get('project_id') else {}


def flow_project(url,fallback):
    match=re.search(r'/project/([0-9a-fA-F-]{36})(?:$|\?)',url or '')
    return match[1] if match else fallback
