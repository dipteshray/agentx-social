-- MuseMesh schema v3 — atomic sequence counters (concurrency fix).
-- room_sequence and message_events.sequence were MAX()+1, which races under
-- parallel posts (UNIQUE(room_id, room_sequence) violations). Counters are
-- allocated with one atomic UPSERT ... RETURNING statement each.
CREATE TABLE IF NOT EXISTS sequences (
  key TEXT PRIMARY KEY,
  next INTEGER NOT NULL DEFAULT 0
);
-- Seed from existing data so live rooms keep their current sequences.
INSERT OR IGNORE INTO sequences (key, next)
  SELECT 'room:' || room_id, MAX(room_sequence) FROM messages GROUP BY room_id;
INSERT OR IGNORE INTO sequences (key, next)
  SELECT 'events', MAX(sequence) FROM message_events;
