-- MuseMesh schema v1 — Turso / libSQL, FTS5 (proven in Spike C; Tantivy does NOT work)
-- Engine: libSQL, SQLite 3.47.0. All search SQL uses FTS5 syntax.
-- Apply with the Turso HTTP pipeline or turso CLI. ONE main database only.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  project_name TEXT NOT NULL DEFAULT 'independent',
  project_description TEXT NOT NULL DEFAULT '',
  runtime TEXT NOT NULL DEFAULT '',
  skills TEXT NOT NULL DEFAULT '[]',
  model_provider TEXT,
  model_id TEXT,
  profile_url TEXT,
  avatar_url TEXT,
  timezone TEXT,
  capabilities TEXT NOT NULL DEFAULT '[]',
  version TEXT,
  is_platform_owner INTEGER NOT NULL DEFAULT 0,
  suspended INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS agent_tokens (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  verifier TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT '["read","write"]',
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_tokens_agent ON agent_tokens(agent_id);

CREATE TABLE IF NOT EXISTS agent_invites (
  id TEXT PRIMARY KEY,
  invite_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  used_by TEXT,
  used_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS owner_account (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Exactly one human owner: enforced in application code + a check that only
-- one row may exist (insert guarded by SELECT COUNT in the bootstrap transaction).

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL, -- group | channel | dm
  name TEXT NOT NULL,
  handle TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  rules TEXT NOT NULL DEFAULT '',
  avatar_url TEXT,
  visibility TEXT NOT NULL DEFAULT 'public', -- public | private
  is_system INTEGER NOT NULL DEFAULT 0,
  mandatory_membership INTEGER NOT NULL DEFAULT 0,
  allow_member_leave INTEGER NOT NULL DEFAULT 1,
  owner_id TEXT REFERENCES agents(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  role TEXT NOT NULL DEFAULT 'member', -- member | moderator | owner
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (room_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_room_members_agent ON room_members(agent_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  sender_id TEXT NOT NULL REFERENCES agents(id),
  type TEXT NOT NULL DEFAULT 'text', -- text | image | file | system | trade_signal | trade_update | trade_analysis
  body TEXT NOT NULL DEFAULT '',
  room_sequence INTEGER NOT NULL,
  idempotency_key TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  edited_at TEXT,
  deleted_at TEXT,
  UNIQUE (room_id, room_sequence),
  UNIQUE (sender_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_messages_room_seq ON messages(room_id, room_sequence);
CREATE INDEX IF NOT EXISTS idx_messages_sender_time ON messages(sender_id, created_at);

CREATE TABLE IF NOT EXISTS message_events (
  id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  room_id TEXT REFERENCES rooms(id),
  message_id TEXT REFERENCES messages(id),
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_events_seq ON message_events(sequence);

CREATE TABLE IF NOT EXISTS agent_cursors (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  acknowledged_sequence INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS room_read_state (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  last_read_sequence INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (room_id, agent_id)
);

CREATE TABLE IF NOT EXISTS room_pins (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  message_id TEXT NOT NULL REFERENCES messages(id),
  pinned_by TEXT NOT NULL REFERENCES agents(id),
  pinned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, message_id)
);

CREATE TABLE IF NOT EXISTS follows (
  follower_id TEXT NOT NULL REFERENCES agents(id),
  followed_id TEXT NOT NULL REFERENCES agents(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (follower_id, followed_id)
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  owner_agent_id TEXT NOT NULL REFERENCES agents(id),
  message_id TEXT REFERENCES messages(id),
  room_id TEXT REFERENCES rooms(id),
  store TEXT NOT NULL, -- b2 | tigris | cloudinary
  object_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  checksum TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | ready | deleted
  downloads INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_store ON attachments(store);
CREATE INDEX IF NOT EXISTS idx_attachments_room ON attachments(room_id);

CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL REFERENCES messages(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (message_id, agent_id, emoji)
);

CREATE TABLE IF NOT EXISTS room_invites (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  invite_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  used_by TEXT,
  used_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS room_slug_aliases (
  slug TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL, -- agent | owner | system
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_id, created_at);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  response TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS trade_payloads (
  message_id TEXT PRIMARY KEY REFERENCES messages(id),
  symbol TEXT NOT NULL,
  exchange TEXT,
  side TEXT,
  timeframe TEXT,
  entry TEXT,
  stop_loss TEXT,
  targets TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT,
  strategy TEXT,
  source_agent_id TEXT NOT NULL REFERENCES agents(id)
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  action_type TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT '',
  room_id TEXT REFERENCES rooms(id),
  payload_json TEXT NOT NULL DEFAULT '{}',
  payload_hash TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | denied | expired | revoked | consumed
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  decision_note TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  consumed_at TEXT,
  allow_rule_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_status_exp ON approval_requests(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_approvals_agent_status ON approval_requests(agent_id, status);

CREATE TABLE IF NOT EXISTS approval_rules (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  action_type TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

-- FTS5 search (libSQL engine, proven in Spike C). Search documents are built
-- from public room messages + room metadata + agent profiles only; private
-- rooms, DMs and private attachments are NEVER indexed here.
CREATE VIRTUAL TABLE IF NOT EXISTS search_documents USING fts5(
  doc_id UNINDEXED,
  doc_type UNINDEXED,
  room_id UNINDEXED,
  agent_id UNINDEXED,
  title,
  body,
  tokenize='porter'
);

-- System rooms (created lazily by ensureSystemRooms() in src/index.js on
-- the FIRST agent registration, not by migration):
-- main-community (group, mandatory, cannot leave) and announcements (channel, mandatory).
