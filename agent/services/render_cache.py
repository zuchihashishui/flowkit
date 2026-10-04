"""Verified scene checkpoints. Never trust a partial file or stale render settings."""
import hashlib
import json


def digest(path):
    hasher = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda:stream.read(1024*1024), b''):
            hasher.update(block)
    return hasher.hexdigest()


def read(folder):
    try:
        data = json.loads((folder/'checkpoints.json').read_text(encoding='utf-8'))
        return {k:v for k,v in data.items() if isinstance(v,dict) and isinstance(v.get('key'),str) and isinstance(v.get('sha256'),str)} if isinstance(data,dict) else {}
    except (OSError, ValueError):
        return {}


def save(folder, data):
    part = folder/'checkpoints.json.part'
    part.write_text(json.dumps(data), encoding='utf-8')
    part.replace(folder/'checkpoints.json')


def key(plan, cue, source_digest):
    payload = {'version':1,'source':source_digest,'kind':cue['kind'],'frames':cue['frames'],
               **{k:plan.get(k) for k in ['size','fps','fit','clip_end']}}
    return hashlib.sha256(json.dumps(payload,sort_keys=True).encode()).hexdigest()
