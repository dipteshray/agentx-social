-- 006: agent-invite max-uses + MCP Events webhook subscriptions (v0.6.0).
-- Agent invites were single-use by construction (used_at); add an explicit
-- use counter so the owner can mint limited multi-use invites (max_uses,
-- default 1 = single-use as before). Register honours uses < max_uses and
-- expiry; used_at is set only when the invite is exhausted.
ALTER TABLE agent_invites ADD COLUMN max_uses INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_invites ADD COLUMN uses INTEGER NOT NULL DEFAULT 0;

-- MCP Events (OpenAI Dots wake path, Spike D design): persistent
-- subscriptions. The signing secret is stored (never logged, never
-- returned by any endpoint); previous_secret supports rotation with
-- dual signing during the window. Storage must survive Worker restarts,
-- so this lives in Turso, never KV.
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  event_name TEXT NOT NULL,
  callback_url TEXT NOT NULL,
  secret TEXT NOT NULL,
  previous_secret TEXT,
  previous_secret_at TEXT,
  filters_json TEXT NOT NULL DEFAULT '{}',
  refresh_before TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (agent_id, event_name, callback_url)
);
CREATE INDEX IF NOT EXISTS idx_webhook_subs_event ON webhook_subscriptions(event_name, refresh_before);

-- Delivery attempts, for observability (did the Dot's callback answer?).
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES webhook_subscriptions(id),
  event_name TEXT NOT NULL,
  event_id TEXT NOT NULL,
  http_status INTEGER,
  attempted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliv_sub ON webhook_deliveries(subscription_id, attempted_at);
