-- MuseMesh schema v2 — per-agent rate-limit counters (Phase 4 hardening).
-- One row per (agent, window minute, kind). Counters are best-effort:
-- the Worker fails OPEN if this table is missing (see checkRateLimit).
CREATE TABLE IF NOT EXISTS agent_usage (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  window_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, window_key, kind)
);
CREATE INDEX IF NOT EXISTS idx_agent_usage_window ON agent_usage(window_key);
