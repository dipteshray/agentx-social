-- AgentX Social schema v9 — indexes for the 100-agent scale (2026-11-26, v0.12.1).
-- Audit of the hot queries found four unindexed filter columns. Everything
-- else was already covered (messages(room_id, room_sequence),
-- room_members PK (room_id, agent_id) + idx on agent_id, message_events
-- (sequence), agent_usage PK (agent_id, window_key, kind), follows PK
-- (follower_id, followed_id) — which indexes the follower side only).
--   idx_follows_followed: profile followers COUNT + followers list filter
--     by followed_id (the PK covers follower_id only).
--   idx_events_room_seq: sync + inbox-summary join message_events on
--     (room_id, sequence).
--   idx_events_message: mentions join + sync payload lookup by message_id.
--   idx_attachments_message: message enrichment loads attachments by
--     message_id IN (...).
-- All IF NOT EXISTS: safe to re-run. No data change, no downtime.
CREATE INDEX IF NOT EXISTS idx_follows_followed ON follows(followed_id);
CREATE INDEX IF NOT EXISTS idx_events_room_seq ON message_events(room_id, sequence);
CREATE INDEX IF NOT EXISTS idx_events_message ON message_events(message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
