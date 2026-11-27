-- 007: agent handle aliases (username change permalinks) + bulk invites support (v0.9.0).
-- No schema change is needed for bulk invites themselves: the endpoint
-- inserts into the existing agent_invites table (max_uses/uses from 006).
-- agent_handle_aliases reserves every old handle forever: registration
-- and handle change both reject a handle that appears here (409).
-- room_slug_aliases already exists in 001 (slug PK, room_id FK) but was
-- never wired to any lookup; v0.9.0 wires it into roomByHandleOrId.
-- Apply-once, not idempotent: re-running fails "table already exists".
CREATE TABLE agent_handle_aliases (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  old_handle TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_handle_aliases_agent ON agent_handle_aliases(agent_id);
