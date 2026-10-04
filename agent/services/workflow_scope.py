"""Additive ownership and immutable input references beside each service's jobs.

Keeping these rows in the job database makes creation + ownership one transaction.
Old rows have no owner until explicitly assigned; file paths never come from clients.
"""
import json
import sqlite3
import time

SCHEMA = '''CREATE TABLE IF NOT EXISTS resource_scope (
 kind TEXT NOT NULL, resource_id TEXT NOT NULL, project_id TEXT, video_id TEXT,
 sources TEXT NOT NULL DEFAULT '[]', created REAL NOT NULL,
 PRIMARY KEY(kind, resource_id));
 CREATE INDEX IF NOT EXISTS resource_scope_video ON resource_scope(video_id,kind);
 CREATE TABLE IF NOT EXISTS job_settings(kind TEXT NOT NULL,resource_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,resource_id));'''


def initialize(db):
    db.executescript(SCHEMA)


def ref(kind, rid):
    return {'kind': kind, 'id': str(rid)}


def record(db, kind, rid, context=None, sources=()):
    context = context or {}
    db.execute('INSERT INTO resource_scope VALUES(?,?,?,?,?,?)',
               (kind, str(rid), context.get('project_id'), context.get('video_id'),
                json.dumps(list(sources)), time.time()))


def ownership(db, kind, rid):
    row = db.execute('SELECT * FROM resource_scope WHERE kind=? AND resource_id=?', (kind, str(rid))).fetchone()
    return {'project_id': row['project_id'] if row else None,
            'video_id': row['video_id'] if row else None,
            'sources': json.loads(row['sources']) if row else []}


def annotate(service, kind, rows):
    with service.db() as db:
        return [{**r, 'resource_kind': kind, **ownership(db, kind, r['id'])} for r in rows]


def select(rows, project_id=None, video_id=None, unassigned=False):
    if unassigned:
        return [r for r in rows if not r.get('project_id') and not r.get('video_id')]
    return [r for r in rows if (not project_id or r.get('project_id') == project_id)
            and (not video_id or r.get('video_id') == video_id)]


def job_filter(kind, column, filters=None):
    """Filter before the history limit; other videos cannot hide older results."""
    filters = filters or {}
    if filters.get('unassigned'):
        return f'WHERE {column} NOT IN (SELECT resource_id FROM resource_scope WHERE kind=? AND (project_id IS NOT NULL OR video_id IS NOT NULL))', (kind,)
    fields = [(k, filters[k]) for k in ('project_id', 'video_id') if filters.get(k)]
    if not fields:
        return '', ()
    return f"WHERE {column} IN (SELECT resource_id FROM resource_scope WHERE kind=? AND " + ' AND '.join(k+'=?' for k, _ in fields) + ')', (kind, *(v for _, v in fields))


def has_owned_resources(project_id=None, video_id=None):
    for service in dict.fromkeys(p[0] for p in providers().values()):
        with service.db() as db:
            column, value = ('video_id', video_id) if video_id else ('project_id', project_id)
            if db.execute(f'SELECT 1 FROM resource_scope WHERE {column}=? LIMIT 1', (value,)).fetchone():
                return True
    return False


def providers():
    # Lazy imports avoid service startup cycles.
    from agent.api.elevenlabs import bridge
    from agent.api.whisperx import service as wx
    from agent.api.srt import service as srt
    from agent.api.assembly import service as assembly
    return {'elevenlabs': (bridge, 'eleven_jobs'), 'audio': (wx, 'wx_sources'),
            'whisperx': (wx, 'wx_jobs'), 'json': (srt, 'srt_sources'),
            'srt': (srt, 'srt_jobs'), 'asset': (assembly, 'assembly_assets'),
            'assembly': (assembly, 'assembly_jobs')}


def resource(kind, rid):
    registry = providers()
    if kind not in registry:
        raise ValueError('Unknown resource type.')
    service, table = registry[kind]
    with service.db() as db:
        row = db.execute(f'SELECT * FROM {table} WHERE id=?', (str(rid),)).fetchone()
        if not row:
            raise ValueError('Source no longer exists: ' + kind + '/' + str(rid))
        return describe(db, kind, row)


def describe(db, kind, row):
    scope = ownership(db, kind, row['id'])
    # Only exact existing foreign IDs are inferred for legacy rows. Ownership
    # is never guessed from filenames, titles or the currently selected project.
    if not scope['sources']:
        if kind == 'whisperx':
            local = db.execute('SELECT id FROM wx_sources WHERE id=?', (row['source_id'],)).fetchone()
            scope['sources'] = [ref('audio' if local else 'elevenlabs', row['source_id'])]
        elif kind == 'srt':
            scope['sources'] = [ref('json', row['source_id'])]
        elif kind == 'assembly':
            plan = json.loads(row['plan'])
            scope['sources'] = [ref('asset', i) for i in dict.fromkeys([plan['audio_id'], plan['srt_id'], *plan.get('image_ids', []), *plan.get('video_ids', [])])]
    return {'id': str(row['id']), 'resource_kind': kind, 'title': row['title'],
            'state': row['state'] if 'state' in row.keys() else 'IMPORTED',
            'created': row['created'], 'asset_type': row['kind'] if kind == 'asset' else None,
            'result_available': bool(row['merged_file']) if kind == 'elevenlabs' else ('state' in row.keys() and row['state'] == 'COMPLETED'), **scope}


def audio_ref(service, source_id):
    with service.db() as db:
        local = db.execute('SELECT id FROM wx_sources WHERE id=?', (source_id,)).fetchone()
    return ref('audio' if local else 'elevenlabs', source_id)


def resolve(context=None, sources=(), parents=None):
    """Inherit the exact source owner, or require all supplied inputs to match."""
    context = {k: (context or {}).get(k) for k in ('project_id', 'video_id')}
    parents = parents if parents is not None else [resource(s['kind'], s['id']) for s in sources]
    if not any(context.values()):
        owners = {(p['project_id'], p['video_id']) for p in parents if p['video_id']}
        if len(owners) > 1:
            raise ValueError('Inputs belong to different videos.')
        if owners:
            context = dict(zip(('project_id', 'video_id'), owners.pop()))
    if bool(context['project_id']) != bool(context['video_id']):
        raise ValueError('Select both a project and a video.')
    if context['video_id']:
        for parent in parents:
            if any(parent[k] != context[k] for k in ('project_id', 'video_id')):
                raise ValueError('Input is unassigned or belongs to another video. Assign its source chain in Projects first.')
    return context


def catalog():
    result = []
    for kind, (service, table) in providers().items():
        with service.db() as db:
            result.extend(describe(db, kind, row) for row in db.execute(f'SELECT * FROM {table} ORDER BY created DESC'))
    result.sort(key=lambda r: r['created'] or 0, reverse=True)
    return result


def assignment_plan(kind, rid, context):
    items = catalog()
    mapping = {(r['resource_kind'], r['id']): r for r in items}
    key = (kind, rid)
    if key not in mapping:
        raise ValueError('Resource not found.')
    related = {key}
    while True:
        before = len(related)
        for key, row in mapping.items():
            sources = {(s['kind'], s['id']) for s in row['sources']}
            if key in related or sources & related:
                if any(s not in mapping for s in sources):
                    raise ValueError('A linked source is missing. Restore it before assigning this chain.')
                related.add(key)
                related.update(sources)
        if len(related) == before:
            break
    selected = [mapping[k] for k in sorted(related)]
    for item in selected:
        if item['state'] in ('QUEUED', 'RUNNING', 'SUBMITTING', 'DOWNLOADING'):
            raise ValueError('Wait for or cancel active jobs before assigning their source chain.')
        if item['video_id'] and any(item[k] != context[k] for k in ('project_id', 'video_id')):
            raise ValueError('This chain already belongs to another video. Import a separate copy instead of moving existing results.')
    return selected


def assign(kind, rid, context):
    selected = assignment_plan(kind, rid, context)
    stores = list(dict.fromkeys(str(p[0].store) for p in providers().values()))
    # One SQLite transaction across the attached local service databases. Partial
    # ownership changes must never leave audio and its transcript in two videos.
    db = sqlite3.connect(stores[0], timeout=10)
    try:
        aliases = {stores[0]: 'main'}
        for index, store in enumerate(stores[1:], 1):
            alias = 'source' + str(index)
            db.execute(f'ATTACH DATABASE ? AS {alias}', (store,))
            aliases[store] = alias
        db.execute('BEGIN IMMEDIATE')
        for item in selected:
            service, table = providers()[item['resource_kind']]
            alias = aliases[str(service.store)]
            owner = db.execute(f'SELECT project_id,video_id FROM {alias}.resource_scope WHERE kind=? AND resource_id=?',
                               (item['resource_kind'], item['id'])).fetchone()
            if owner and any(owner) and tuple(owner) != (context['project_id'], context['video_id']):
                raise ValueError('This source was assigned to another video. Refresh before continuing.')
            current = db.execute(f'SELECT state FROM {alias}.{table} WHERE id=?', (item['id'],)).fetchone() if item['state'] != 'IMPORTED' else None
            if current and current[0] in ('QUEUED', 'RUNNING', 'SUBMITTING', 'DOWNLOADING'):
                raise ValueError('A job started while assigning. Try again after it finishes.')
            db.execute(f'''INSERT INTO {alias}.resource_scope VALUES(?,?,?,?,?,?)
                ON CONFLICT(kind,resource_id) DO UPDATE SET project_id=excluded.project_id,video_id=excluded.video_id''',
                (item['resource_kind'], item['id'], context['project_id'], context['video_id'], json.dumps(item['sources']), time.time()))
        db.commit()
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()
    return {'assigned': len(selected)}


def save_settings(db,kind,rid,settings):
    db.execute('INSERT OR REPLACE INTO job_settings VALUES(?,?,?)',(kind,str(rid),json.dumps(settings or {})))

def load_settings(service,kind,rid):
    with service.db() as db:
        row=db.execute('SELECT value FROM job_settings WHERE kind=? AND resource_id=?',(kind,str(rid))).fetchone()
    return json.loads(row['value']) if row else {}
