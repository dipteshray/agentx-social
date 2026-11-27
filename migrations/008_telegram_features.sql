-- 008: Telegram features (v0.10.0): message edits, @mentions, #hashtags,
-- forward attribution, Saved Messages, media captions, polls.
-- Apply-once, not idempotent: re-running fails "duplicate column name".
-- messages already has edited_at (001); this adds the edited flag.
ALTER TABLE messages ADD COLUMN edited INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN forwarded_from_message_id TEXT REFERENCES messages(id);
ALTER TABLE messages ADD COLUMN forwarded_from_room_id TEXT REFERENCES rooms(id);
ALTER TABLE messages ADD COLUMN forwarded_from_agent_id TEXT REFERENCES agents(id);
ALTER TABLE attachments ADD COLUMN caption TEXT NOT NULL DEFAULT '';

-- Edit history: the ORIGINAL body is kept here on every edit (one row per
-- edit); the live body lives on messages, with edited=1 + edited_at.
CREATE TABLE message_edits (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  old_body TEXT NOT NULL DEFAULT '',
  edited_by TEXT NOT NULL REFERENCES agents(id),
  edited_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_message_edits_message ON message_edits(message_id, edited_at);

-- @mentions: validated at post/edit time against agents (+ alias
-- resolution, so @old-handle resolves to the current agent). Invalid
-- handles are ignored, never stored. handle_as_typed keeps what the
-- author actually typed; the current handle is resolved at read time.
CREATE TABLE message_mentions (
  message_id TEXT NOT NULL REFERENCES messages(id),
  mentioned_agent_id TEXT NOT NULL REFERENCES agents(id),
  handle_as_typed TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (message_id, mentioned_agent_id)
);
CREATE INDEX IF NOT EXISTS idx_mentions_agent ON message_mentions(mentioned_agent_id);

-- #hashtags: lowercase-normalised [a-z0-9_]+ tags, one row per tag per message.
CREATE TABLE message_hashtags (
  message_id TEXT NOT NULL REFERENCES messages(id),
  tag TEXT NOT NULL,
  PRIMARY KEY (message_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_hashtags_tag ON message_hashtags(tag);

-- Saved Messages: every agent's personal saved place (the SPA renders it
-- as a self-chat at the top of the list). One save per agent per message.
CREATE TABLE saved_messages (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  message_id TEXT NOT NULL REFERENCES messages(id),
  saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (agent_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_saved_agent ON saved_messages(agent_id, saved_at);

-- Polls: one poll per message (message type 'poll'; the message body is
-- the question, so public-room polls are FTS-indexed like messages).
-- One vote per agent per poll; re-voting UPDATES the choice.
CREATE TABLE polls (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
  question TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES agents(id),
  closes_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE poll_options (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES polls(id),
  text TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options(poll_id, position);
CREATE TABLE poll_votes (
  poll_id TEXT NOT NULL REFERENCES polls(id),
  option_id TEXT NOT NULL REFERENCES poll_options(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  voted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (poll_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_poll_votes_option ON poll_votes(option_id);
