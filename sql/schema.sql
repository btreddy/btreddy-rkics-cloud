-- RkICS Supervisor Tracker — Postgres schema (for Supabase)
-- Run this once in Supabase's SQL Editor before first deploy.

CREATE TABLE IF NOT EXISTS supervisors (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  telegram_chat_id TEXT UNIQUE,
  whatsapp_number TEXT UNIQUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  default_site_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sites (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  geofence_radius_m INTEGER,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE supervisors ADD CONSTRAINT fk_default_site
  FOREIGN KEY (default_site_id) REFERENCES sites(id);

CREATE TABLE IF NOT EXISTS checkins (
  id SERIAL PRIMARY KEY,
  supervisor_id INTEGER NOT NULL REFERENCES supervisors(id),
  site_id INTEGER REFERENCES sites(id),
  type TEXT NOT NULL CHECK (type IN ('IN','OUT')),
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  distance_from_site_m DOUBLE PRECISION,
  flagged BOOLEAN NOT NULL DEFAULT FALSE,
  flag_reason TEXT,
  reason TEXT,
  channel TEXT NOT NULL DEFAULT 'telegram',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dpr_reports (
  id SERIAL PRIMARY KEY,
  supervisor_id INTEGER NOT NULL REFERENCES supervisors(id),
  site_id INTEGER REFERENCES sites(id),
  content TEXT,
  content_type TEXT NOT NULL DEFAULT 'text' CHECK (content_type IN ('text','voice')),
  channel TEXT NOT NULL DEFAULT 'telegram',
  transcribed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Voice audio kept as a blob right in Postgres (Supabase's free tier storage
-- comfortably fits many voice notes — a typical 30-60s note is well under
-- 1MB). Keeps the whole system to ONE credential (the database), no
-- separate file-storage service to wire up.
CREATE TABLE IF NOT EXISTS voice_audio (
  dpr_id INTEGER PRIMARY KEY REFERENCES dpr_reports(id),
  data BYTEA NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'audio/ogg',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Replaces the old bot's in-memory "pending" Map. A Vercel function has no
-- memory between one incoming message and the next (each request can be a
-- fresh instance), so the multi-step "pick a site, then share location"
-- flow needs to live in the database instead — this table is exactly that.
CREATE TABLE IF NOT EXISTS pending_actions (
  chat_id TEXT PRIMARY KEY,
  action TEXT,           -- 'IN' | 'OUT' | 'DPR'
  site_id INTEGER,
  dpr_text TEXT,
  awaiting_reason BOOLEAN NOT NULL DEFAULT FALSE,
  reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_checkins_supervisor_date ON checkins(supervisor_id, created_at);
CREATE INDEX IF NOT EXISTS idx_dpr_supervisor_date ON dpr_reports(supervisor_id, created_at);
