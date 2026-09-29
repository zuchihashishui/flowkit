"""Additive storyboard schema, kept alongside the existing project/video tables."""
SCHEMA = """
CREATE TABLE IF NOT EXISTS script_document (
 id TEXT PRIMARY KEY,
 video_id TEXT NOT NULL UNIQUE REFERENCES video(id) ON DELETE CASCADE,
 script_text TEXT NOT NULL DEFAULT '',
 visual_style TEXT NOT NULL DEFAULT '',
 revision INTEGER NOT NULL DEFAULT 1,
 audio_path TEXT, audio_name TEXT, audio_duration_ms INTEGER,
 created REAL NOT NULL, updated REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS script_segment (
 id TEXT PRIMARY KEY,
 document_id TEXT NOT NULL REFERENCES script_document(id) ON DELETE CASCADE,
 ordinal INTEGER NOT NULL,
 start_ms INTEGER NOT NULL CHECK(start_ms >= 0),
 end_ms INTEGER NOT NULL CHECK(end_ms > start_ms),
 text TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 active_concept_id TEXT,
 UNIQUE(document_id, ordinal)
);
CREATE TABLE IF NOT EXISTS scene_concept (
 id TEXT PRIMARY KEY,
 segment_id TEXT NOT NULL REFERENCES script_segment(id) ON DELETE CASCADE,
 version INTEGER NOT NULL,
 segment_revision INTEGER NOT NULL,
 document_revision INTEGER NOT NULL,
 title TEXT NOT NULL, description TEXT NOT NULL,
 image_prompt TEXT NOT NULL, video_prompt TEXT NOT NULL,
 provider TEXT NOT NULL, source_text TEXT NOT NULL,
 created REAL NOT NULL,
 UNIQUE(segment_id, version)
);
CREATE TABLE IF NOT EXISTS concept_job (
 id TEXT PRIMARY KEY,
 segment_id TEXT NOT NULL REFERENCES script_segment(id) ON DELETE CASCADE,
 state TEXT NOT NULL,
 payload TEXT NOT NULL,
 error TEXT, concept_id TEXT,
 created REAL NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_concept_job_active ON concept_job(segment_id)
 WHERE state IN ('QUEUED','RUNNING');
CREATE INDEX IF NOT EXISTS idx_segment_document ON script_segment(document_id,ordinal);
CREATE INDEX IF NOT EXISTS idx_concept_segment ON scene_concept(segment_id,version);
CREATE INDEX IF NOT EXISTS idx_concept_job_state ON concept_job(state,created);
"""
