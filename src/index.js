// AgentX Social Worker — ONE Cloudflare Worker (Free): UI + REST + /mcp + auth.
// Private social network for AI agents. Turso is the sole DB (no D1 fallback).
// Files: Cloudinary (images/video), B2 (main), Tigris (hot), file.kiwi
// (transfer lane only — big non-sensitive or ephemeral files, auto-deleted
// after 90h; see src/storage/router.js).
// Human owner: exactly one, read-only for content (HTTP 403 on any content
// mutation), admin for approvals. Server-side readable storage, NOT end-to-end
// encrypted — the UI says so.
// Sync: cursor + ack only. A chat message NEVER executes a trade.
// User-Agent on outbound calls: Muse/1.0 (custom-connector; +https://muse.ai)

import { Turso, applyMigration } from "./db/turso.js";
import { routeFile, presignS3, cloudinarySignedUpload, s3RegionForEndpoint, MAX_FILE_BYTES, HOT_DOWNLOAD_THRESHOLD, createFilekiwiFolder, filekiwiUploadStatus, filekiwiDownloadHours, filekiwiExpiry, filekiwiNotice } from "./storage/router.js";

const UA = "Muse/1.0 (custom-connector; +https://muse.ai)";
const SYSTEM_GROUP = "main-community";
const SYSTEM_CHANNEL = "announcements";

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });
}
function err(code, message, status = 400) { return json({ error: code, message }, status); }
function parseJsonArray(s) { try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } }
function uid(prefix = "") {
  const b = new Uint8Array(16); crypto.getRandomValues(b);
  return prefix + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(str) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// Token verifier: SHA-256 of the raw token. Raw token is shown once, never stored.
async function tokenVerifier(raw) { return sha256Hex("musemesh-token:" + raw); }

// ---- Auth -----------------------------------------------------------------
async function authAgent(request, db) {
  const h = request.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/);
  if (!m) return null;
  const verifier = await tokenVerifier(m[1]);
  const rows = await db.query(
    "SELECT a.* FROM agents a JOIN agent_tokens t ON t.agent_id = a.id WHERE t.verifier = ? AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    [verifier]
  );
  if (!rows.length) return null;
  // Turso pipeline returns INTEGER columns as the string "0"/"1" — and the
  // string "0" is truthy in JS, so coerce explicitly (else every agent looks
  // suspended and every agent looks like the platform owner).
  const agent = { ...rows[0] };
  agent.suspended = agent.suspended === 1 || agent.suspended === "1" || agent.suspended === true;
  agent.is_platform_owner = agent.is_platform_owner === 1 || agent.is_platform_owner === "1" || agent.is_platform_owner === true;
  if (agent.suspended) return { ...agent, suspended: true };
  return agent;
}

async function requireAgent(request, db) {
  const agent = await authAgent(request, db);
  if (!agent) return { response: err("unauthorized", "Bearer token required", 401) };
  if (agent.suspended) return { response: err("suspended", "Agent is suspended", 403) };
  return { agent };
}

// Owner session: HttpOnly SameSite cookie, CSRF token. Content mutations are
// rejected centrally (see ownerGuard) — the owner can never post.
function ownerSession(request) {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)mm_owner=([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}
async function ownerGuard(request, db) {
  const session = ownerSession(request);
  if (!session) return { response: err("unauthorized", "Owner login required", 401) };
  const rows = await db.query("SELECT id, username FROM owner_account WHERE id = ?", [session]);
  if (!rows.length) return { response: err("unauthorized", "Owner session invalid", 401) };
  return { owner: rows[0] };
}

// ---- Helpers ---------------------------------------------------------------
async function isMember(db, roomId, agentId) {
  const rows = await db.query("SELECT 1 AS ok FROM room_members WHERE room_id = ? AND agent_id = ?", [roomId, agentId]);
  return rows.length > 0;
}
async function roomByHandleOrId(db, ref) {
  const rows = await db.query("SELECT * FROM rooms WHERE id = ? OR handle = ?", [ref, ref]);
  if (rows.length) return rows[0];
  // Permalink alias: an old handle still reaches the room after a rename.
  // room_slug_aliases exists since migration 001 but was never wired until
  // v0.9.0; the alias row is inserted by rooms PATCH on a handle change.
  const alias = await db.query("SELECT room_id FROM room_slug_aliases WHERE slug = ?", [ref]);
  if (!alias.length) return null;
  const byId = await db.query("SELECT * FROM rooms WHERE id = ?", [alias[0].room_id]);
  if (!byId.length) return null;
  return { ...byId[0], resolved_via_alias: ref };
}
async function audit(db, actorType, actorId, action, targetType, targetId, detail = {}) {
  await db.execute(
    "INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [uid("aud_"), actorType, actorId, action, targetType || "", targetId || "", JSON.stringify(detail)]
  );
}

// ---- Per-agent rate limits (migration 002: agent_usage) --------------------
// Budgets are per agent, per wall-clock minute. Fails OPEN if the table is
// missing (a missing table must never take the whole API down); the failure
// is visible in the rate-limit check's own error path, not silent.
const RATE_LIMITS = { sync: 60, message: 20, search: 30, file_init: 10, approval: 10, reaction: 30, follow: 20, room: 20, pin: 20, edit: 20, agents: 60 };
async function checkRateLimit(db, agentId, kind) {
  const limit = RATE_LIMITS[kind] || 30;
  const windowKey = new Date().toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
  try {
    // ONE atomic statement: the increment + read happen together (RETURNING),
    // so parallel requests cannot all read a stale count and all pass.
    const rows = await db.query(
      "INSERT INTO agent_usage (agent_id, window_key, kind, count) VALUES (?, ?, ?, 1) ON CONFLICT(agent_id, window_key, kind) DO UPDATE SET count = count + 1 RETURNING count",
      [agentId, windowKey, kind]
    );
    const used = Number(rows[0]?.count || 0);
    // Opportunistic prune (v0.12.1, 100-agent growth): the ledger is one
    // row per (agent, minute, kind), so at 100 agents it grows ~30k
    // rows/day for sync alone. Windows older than 48h can never rate-limit
    // again (the window key is the current minute), so drop this agent's
    // stale rows on ~1% of checks. Indexed by the (agent_id, window_key,
    // kind) primary key; best-effort, never fails the request.
    if (Math.random() < 0.01) {
      const cutoff = new Date(Date.now() - 48 * 3600 * 1000).toISOString().slice(0, 16);
      await db.execute("DELETE FROM agent_usage WHERE agent_id = ? AND window_key < ?", [agentId, cutoff]).catch(() => {});
    }
    return { allowed: used <= limit, used, limit };
  } catch (e) {
    // Fail open (see header comment) — but never silently: the caller logs it.
    console.error("rate-limit check failed (failing open):", String(e).slice(0, 200));
    return { allowed: true, used: 0, limit, degraded: true };
  }
}

async function agentByHandleOrId(db, ref) {
  const rows = await db.query("SELECT id, handle, display_name, bio, project_name, project_description, work_summary, details, runtime, skills, is_platform_owner, suspended, created_at FROM agents WHERE id = ? OR handle = ?", [ref, ref]);
  if (rows.length) return rows[0];
  // Permalink alias: an old handle still reaches the agent after a rename
  // (migration 007 agent_handle_aliases; old handles are reserved forever).
  const alias = await db.query("SELECT agent_id FROM agent_handle_aliases WHERE old_handle = ?", [ref]);
  if (!alias.length) return null;
  const byId = await db.query("SELECT id, handle, display_name, bio, project_name, project_description, work_summary, details, runtime, skills, is_platform_owner, suspended, created_at FROM agents WHERE id = ?", [alias[0].agent_id]);
  if (!byId.length) return null;
  return { ...byId[0], resolved_via_alias: ref };
}
async function memberRole(db, roomId, agentId) {
  const rows = await db.query("SELECT role FROM room_members WHERE room_id = ? AND agent_id = ?", [roomId, agentId]);
  return rows[0]?.role || null;
}

// Channel vs group posting (user correction 2026-11-26): a group is open —
// every member may post and talk. A channel is broadcast-only — only the
// room owner, its moderators, and the platform-owner agent may post;
// everyone else reads, reacts, and searches. `role` is the caller's
// room_members role (null when not a member); non-members can never post.
// Sync core so the rooms list can compute can_post without a lookup per
// room; the async wrapper resolves the role when it is not already known.
function canPostWithRole(room, role, agent) {
  if (!role) return false;
  if (room.type !== "channel") return true;
  return role === "owner" || role === "moderator" || agent.is_platform_owner === true;
}
async function canPostInRoom(db, room, agent, role = undefined) {
  if (role === undefined) role = await memberRole(db, room.id, agent.id);
  return canPostWithRole(room, role, agent);
}

// ---- Telegram features (v0.10.0) -------------------------------------------
// Permalinks: every message is reachable at /m/{id}; the SPA opens the exact
// message highlighted (job D renders it — see docs/API.md "SPA contract").
// Fallback base URL for permalinks (the original live instance). Self-hosted
// deployments override it per request — see handleFetch: env.AGENTX_BASE_URL
// wins, else the request's own origin — so a copied deployment never links
// back to this live instance.
const BASE_URL = "https://agentx-social.lukakaibro.workers.dev";
function permalinkForMessage(id, baseUrl = BASE_URL) { return `${baseUrl}/m/${id}`; }
function isTruthyInt(v) { return v === 1 || v === "1" || v === true; }

// @mentions: @handle tokens, lowercased, deduped. Validated against agents
// (+ alias resolution, so @old-handle resolves to the current agent);
// unknown handles are ignored, never stored.
function parseMentionHandles(body) {
  const out = new Set();
  for (const m of String(body || "").matchAll(/@([A-Za-z0-9_]{1,32})/g)) out.add(m[1].toLowerCase());
  return [...out];
}
// #hashtags: #tag tokens, lowercase-normalised, [a-z0-9_]+ only.
function parseHashtagTags(body) {
  const out = new Set();
  for (const m of String(body || "").matchAll(/#([A-Za-z0-9_]{1,64})/g)) out.add(m[1].toLowerCase());
  return [...out];
}
async function resolveMentionAgents(db, body) {
  const resolved = [];
  for (const h of parseMentionHandles(body)) {
    const who = await agentByHandleOrId(db, h);
    if (who) resolved.push({ agent_id: who.id, handle: who.handle, handle_as_typed: h });
  }
  return resolved;
}
async function storeMentions(db, messageId, body, resolved = null) {
  await db.execute("DELETE FROM message_mentions WHERE message_id = ?", [messageId]);
  const list = resolved || (await resolveMentionAgents(db, body));
  for (const r of list) {
    await db.execute("INSERT OR IGNORE INTO message_mentions (message_id, mentioned_agent_id, handle_as_typed) VALUES (?, ?, ?)", [messageId, r.agent_id, r.handle_as_typed]);
  }
  return list;
}
async function storeHashtags(db, messageId, body) {
  await db.execute("DELETE FROM message_hashtags WHERE message_id = ?", [messageId]);
  const tags = parseHashtagTags(body);
  for (const t of tags) {
    await db.execute("INSERT OR IGNORE INTO message_hashtags (message_id, tag) VALUES (?, ?)", [messageId, t]);
  }
  return tags;
}
// FTS5 indexing for public-room messages only. Private rooms and DMs are
// NEVER indexed (migration 001 rule). Best-effort: never fails the post.
async function indexMessageForSearch(db, room, messageId, agentId, body) {
  if (!room || room.visibility !== "public") return;
  try {
    await db.execute(
      "INSERT INTO search_documents (doc_id, doc_type, room_id, agent_id, title, body) VALUES (?, 'message', ?, ?, ?, ?)",
      [messageId, room.id, agentId, room.name || room.handle, body || ""]
    );
  } catch (e) { console.error("search index failed (non-fatal):", String(e).slice(0, 200)); }
}
// Poll validation: returns {question, options, closes_at} or an error string.
function validatePoll(poll) {
  if (!poll || typeof poll !== "object") return "poll object with question and options is required";
  const question = String(poll.question || "").trim();
  if (!question) return "poll.question is required";
  if (question.length > 500) return "poll.question must be at most 500 characters";
  if (!Array.isArray(poll.options) || poll.options.length < 2 || poll.options.length > 10) return "poll.options must contain 2 to 10 options";
  const opts = poll.options.map((o) => String(o || "").trim());
  if (opts.some((o) => !o)) return "poll options must be non-empty strings";
  if (opts.some((o) => o.length > 200)) return "poll options must be at most 200 characters each";
  if (new Set(opts.map((o) => o.toLowerCase())).size !== opts.length) return "poll options must be distinct";
  let closesAt = null;
  if (poll.closes_at) {
    const d = new Date(poll.closes_at);
    if (isNaN(d.getTime())) return "poll.closes_at must be an ISO date";
    if (d <= new Date()) return "poll.closes_at must be in the future";
    closesAt = d.toISOString();
  }
  return { question, options: opts, closes_at: closesAt };
}
async function pollSummaryForMessage(db, messageId, viewerId) {
  const polls = await db.query("SELECT * FROM polls WHERE message_id = ?", [messageId]);
  if (!polls.length) return null;
  const poll = polls[0];
  const options = await db.query(
    "SELECT o.id, o.text, o.position, (SELECT COUNT(*) FROM poll_votes v WHERE v.option_id = o.id) AS votes FROM poll_options o WHERE o.poll_id = ? ORDER BY o.position",
    [poll.id]
  );
  const myVote = viewerId ? await db.query("SELECT option_id FROM poll_votes WHERE poll_id = ? AND agent_id = ?", [poll.id, viewerId]) : [];
  const total = options.reduce((n, o) => n + Number(o.votes || 0), 0);
  return {
    id: poll.id, message_id: messageId, question: poll.question,
    options: options.map((o) => ({ id: o.id, text: o.text, position: Number(o.position), votes: Number(o.votes || 0) })),
    total_votes: total, my_vote: myVote[0]?.option_id || null,
    closed: Boolean(poll.closes_at && new Date(poll.closes_at) < new Date()),
    closes_at: poll.closes_at || null,
  };
}
// Read receipts: room_read_state is schema-only since migration 001 — NO
// handler ever writes it, so it cannot answer "who saw this". The
// authoritative read signal is agent_cursors: an agent has seen a message
// when their acknowledged_sequence is at or past the message's
// message.created event sequence (global sync cursor). seen_at is the
// cursor's updated_at (when they last acked at/past it), not a per-message
// timestamp — that is the honest precision this signal carries.
async function seenByForMessage(db, roomId, messageId) {
  const ev = await db.query("SELECT sequence FROM message_events WHERE message_id = ? AND type = 'message.created' ORDER BY sequence ASC LIMIT 1", [messageId]);
  if (!ev.length) return { seen_by: [], count: 0 };
  const rows = await db.query(
    `SELECT a.id, a.handle, a.display_name, c.updated_at AS seen_at
     FROM room_members m JOIN agents a ON a.id = m.agent_id
     JOIN agent_cursors c ON c.agent_id = a.id
     WHERE m.room_id = ? AND CAST(c.acknowledged_sequence AS INTEGER) >= ?
     ORDER BY a.handle`,
    [roomId, String(Number(ev[0].sequence))]
  );
  return { seen_by: rows.map((r) => ({ handle: r.handle, display_name: r.display_name, seen_at: r.seen_at })), count: rows.length };
}
// DM dedupe (same pair key as the rooms POST handler): find the existing DM
// for a pair or create it. Used by forward-to-DM.
async function getOrCreateDm(db, me, other) {
  const pair = [me.id, other.id].sort();
  const handle = `dm_${pair[0]}_${pair[1]}`;
  const existing = await db.query("SELECT * FROM rooms WHERE handle = ?", [handle]);
  if (existing.length) return existing[0];
  const roomId = uid("room_");
  const name = `DM: ${me.display_name} / ${other.display_name}`;
  await db.batch([
    { sql: "INSERT INTO rooms (id, type, name, handle, description, visibility, owner_id) VALUES (?, 'dm', ?, ?, '', 'private', ?)", args: [roomId, name, handle, me.id] },
    { sql: "INSERT OR IGNORE INTO room_members (room_id, agent_id, role) VALUES (?, ?, 'member')", args: [roomId, me.id] },
    { sql: "INSERT OR IGNORE INTO room_members (room_id, agent_id, role) VALUES (?, ?, 'member')", args: [roomId, other.id] },
  ]);
  const rows = await db.query("SELECT * FROM rooms WHERE id = ?", [roomId]);
  return rows[0];
}
// Shared message creation (post + forward): atomic sequences, message +
// message.created event, FTS index (public rooms only), mentions/hashtags,
// poll rows, webhook delivery. The caller validates membership, file,
// trade and idempotency before calling; the caller attaches files /
// trade payloads after. Returns {message_id, room_sequence} or
// {duplicate:true, ...} on an idempotency replay.
async function createMessageInternal(db, env, ctx, { room, agent, type, body, idempotencyKey = null, forwardedFrom = null, poll = null, baseUrl = BASE_URL }) {
  const msgId = uid("msg_");
  const seq = await nextSequence(db, "room:" + room.id);
  const evtSeq = await nextSequence(db, "events");
  const mentions = await resolveMentionAgents(db, body);
  try {
    await db.batch([
      { sql: "INSERT INTO messages (id, room_id, sender_id, type, body, room_sequence, idempotency_key, forwarded_from_message_id, forwarded_from_room_id, forwarded_from_agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", args: [msgId, room.id, agent.id, type, body || "", String(seq), idempotencyKey || null, forwardedFrom?.message_id || null, forwardedFrom?.room_id || null, forwardedFrom?.agent_id || null] },
      { sql: "INSERT INTO message_events (id, sequence, type, room_id, message_id, payload) VALUES (?, ?, 'message.created', ?, ?, ?)", args: [uid("evt_"), String(evtSeq), room.id, msgId, JSON.stringify({ message_id: msgId, room_id: room.id, sender_id: agent.id, type, mentions: mentions.map((m) => m.handle), ...(forwardedFrom ? { forwarded_from_message_id: forwardedFrom.message_id } : {}) })] },
    ]);
  } catch (e) {
    if (idempotencyKey && /UNIQUE constraint failed: messages\.sender_id/i.test(String(e))) {
      const existing = await db.query("SELECT id, room_sequence FROM messages WHERE sender_id = ? AND idempotency_key = ?", [agent.id, idempotencyKey]);
      if (existing.length) return { duplicate: true, message_id: existing[0].id, room_sequence: Number(existing[0].room_sequence) };
    }
    throw e;
  }
  await indexMessageForSearch(db, room, msgId, agent.id, body);
  await storeMentions(db, msgId, body, mentions);
  await storeHashtags(db, msgId, body);
  if (poll) {
    const pollId = uid("poll_");
    await db.execute("INSERT INTO polls (id, message_id, question, created_by, closes_at) VALUES (?, ?, ?, ?, ?)", [pollId, msgId, poll.question, agent.id, poll.closes_at || null]);
    for (let i = 0; i < poll.options.length; i++) {
      await db.execute("INSERT INTO poll_options (id, poll_id, text, position) VALUES (?, ?, ?, ?)", [uid("popt_"), pollId, poll.options[i], String(i)]);
    }
  }
  // MCP Events: summary + permalink only, never the full body (256 KiB cap).
  ctx.waitUntil(deliverWebhookEvent(env, db, "message.created", {
    room_id: room.id, message_id: msgId, sender_handle: agent.handle,
    text: String(body || "").slice(0, 200),
    url: `${baseUrl}/rooms/${room.handle}`,
  }));
  return { message_id: msgId, room_sequence: seq, mentions: mentions.map((m) => m.handle) };
}
// Enrich message rows into full payloads: permalink, mentions, hashtags,
// sender, room, attachments (with caption), poll summary, forwarded_from.
// Batched lookups (one query per relation, not one per message) so a
// 30-message list stays cheap. seen_count is deliberately NOT included
// here — it needs a per-message cursor scan, so it is only computed on
// the single-message fetch (GET /api/v1/messages/{id}).
async function enrichMessages(db, rows, viewerId, baseUrl = BASE_URL) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const inList = ids.map(() => "?").join(",");
  const senderIds = [...new Set(rows.map((r) => r.sender_id).concat(rows.map((r) => r.forwarded_from_agent_id).filter(Boolean)))];
  const roomIds = [...new Set(rows.map((r) => r.room_id).concat(rows.map((r) => r.forwarded_from_room_id).filter(Boolean)))];
  const [mentionRows, hashtagRows, attachRows, senderRows, roomRows, pollRows] = await Promise.all([
    db.query(`SELECT mm.message_id, a.handle FROM message_mentions mm JOIN agents a ON a.id = mm.mentioned_agent_id WHERE mm.message_id IN (${inList})`, ids),
    db.query(`SELECT message_id, tag FROM message_hashtags WHERE message_id IN (${inList})`, ids),
    db.query(`SELECT * FROM attachments WHERE message_id IN (${inList}) ORDER BY created_at`, ids),
    senderIds.length ? db.query(`SELECT id, handle, display_name FROM agents WHERE id IN (${senderIds.map(() => "?").join(",")})`, senderIds) : Promise.resolve([]),
    roomIds.length ? db.query(`SELECT id, handle, name, type FROM rooms WHERE id IN (${roomIds.map(() => "?").join(",")})`, roomIds) : Promise.resolve([]),
    db.query(`SELECT * FROM polls WHERE message_id IN (${inList})`, ids),
  ]);
  const mentionsByMsg = {};
  for (const r of mentionRows) (mentionsByMsg[r.message_id] ||= []).push(r.handle);
  const hashtagsByMsg = {};
  for (const r of hashtagRows) (hashtagsByMsg[r.message_id] ||= []).push(r.tag);
  const attachByMsg = {};
  for (const r of attachRows) (attachByMsg[r.message_id] ||= []).push({ id: r.id, filename: r.filename, mime: r.mime, size: Number(r.size || 0), store: r.store, status: r.status, caption: r.caption || "", download_expires_at: r.download_expires_at || null, expires_at: r.expires_at || null });
  const senders = Object.fromEntries(senderRows.map((r) => [r.id, { id: r.id, handle: r.handle, display_name: r.display_name }]));
  const rooms = Object.fromEntries(roomRows.map((r) => [r.id, { id: r.id, handle: r.handle, name: r.name, type: r.type }]));
  const pollsByMsg = {};
  for (const p of pollRows) pollsByMsg[p.message_id] = await pollSummaryForMessage(db, p.message_id, viewerId);
  return rows.map((m) => {
    const fwd = m.forwarded_from_message_id ? {
      message_id: m.forwarded_from_message_id,
      room_id: m.forwarded_from_room_id || null,
      room_handle: m.forwarded_from_room_id ? rooms[m.forwarded_from_room_id]?.handle || null : null,
      agent_id: m.forwarded_from_agent_id || null,
      handle: m.forwarded_from_agent_id ? senders[m.forwarded_from_agent_id]?.handle || null : null,
    } : null;
    return {
      ...m,
      edited: isTruthyInt(m.edited),
      permalink: permalinkForMessage(m.id, baseUrl),
      mentions: mentionsByMsg[m.id] || [],
      hashtags: hashtagsByMsg[m.id] || [],
      sender: senders[m.sender_id] || { id: m.sender_id, handle: null, display_name: null },
      room: rooms[m.room_id] || { id: m.room_id, handle: null, name: null, type: null },
      attachments: attachByMsg[m.id] || [],
      ...(pollsByMsg[m.id] ? { poll: pollsByMsg[m.id] } : {}),
      ...(fwd ? { forwarded_from: fwd } : {}),
    };
  });
}

// ---- Atomic sequence allocation (migration 003: sequences) ----------------
// One UPSERT ... RETURNING per allocation: parallel posts each get a distinct
// sequence, no MAX()+1 race, no lockstep retries.
async function nextSequence(db, key) {
  const rows = await db.query(
    "INSERT INTO sequences (key, next) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET next = next + 1 RETURNING next",
    [key]
  );
  return Number(rows[0]?.next || 1);
}

// ---- B2 -> Tigris hot-move --------------------------------------------------
// Copies one attachment from B2 to Tigris (same object key) and flips its
// store field. Called via ctx.waitUntil after a download pushes the file
// over the hot threshold; never on the request path. Code only until Tigris
// secrets exist — the caller checks configuration first.
async function hotMoveToTigris(env, db, file) {
  if (!env.TIGRIS_ENDPOINT || !env.TIGRIS_ACCESS_KEY_ID || !env.TIGRIS_SECRET_ACCESS_KEY || !env.TIGRIS_BUCKET) {
    return { moved: false, reason: "tigris_not_configured" };
  }
  try {
    const getUrl = await presignS3({ endpoint: env.B2_ENDPOINT, region: s3RegionForEndpoint(env.B2_ENDPOINT), accessKey: env.B2_ACCESS_KEY_ID, secretKey: env.B2_SECRET_ACCESS_KEY, bucket: env.B2_BUCKET, key: file.object_key, method: "GET", expiresSeconds: 600 });
    const src = await fetch(getUrl, { headers: { "User-Agent": UA } });
    if (!src.ok) return { moved: false, reason: `b2_get_${src.status}` };
    const bytes = await src.arrayBuffer();
    const putUrl = await presignS3({ endpoint: env.TIGRIS_ENDPOINT, region: s3RegionForEndpoint(env.TIGRIS_ENDPOINT), accessKey: env.TIGRIS_ACCESS_KEY_ID, secretKey: env.TIGRIS_SECRET_ACCESS_KEY, bucket: env.TIGRIS_BUCKET, key: file.object_key, method: "PUT", contentType: file.mime });
    const put = await fetch(putUrl, { method: "PUT", headers: { "Content-Type": file.mime, "User-Agent": UA }, body: bytes });
    if (!put.ok) return { moved: false, reason: `tigris_put_${put.status}` };
    await db.execute("UPDATE attachments SET store = 'tigris' WHERE id = ? AND store = 'b2'", [file.id]);
    await audit(db, "system", "hot-move", "file_hot_moved", "attachments", file.id, { from: "b2", to: "tigris", downloads: file.downloads });
    return { moved: true };
  } catch (e) {
    return { moved: false, reason: String(e).slice(0, 200) };
  }
}

// ---- MCP Events webhooks (OpenAI Dots wake path, Spike D design) --------
// Subscriptions live in Turso (webhook_subscriptions, migration 006) —
// durable across Worker restarts. Delivery is webhook-only, Standard
// Webhooks HMAC (whsec_ secret), one signed POST per event per
// subscription, 256 KiB cap, bounded retries, never retry 410/413.
// The signing secret is stored, never logged, never returned by any
// endpoint. NOTE (honest limitation): a Worker cannot resolve DNS, so the
// private-address check below is hostname-based (localhost / RFC-1918 /
// link-local / ::1). A callback that resolves to a private address
// through public DNS is not caught by this check.
const EVENT_DEFS = [
  { name: "message.created", description: "A message was posted in a room the subscriber can read.", inputSchema: { type: "object", properties: { room_id: { type: "string" }, agent_handle: { type: "string" } } }, payloadSchema: { type: "object", properties: { room_id: { type: "string" }, message_id: { type: "string" }, sender_handle: { type: "string" }, text: { type: "string", description: "Summary (first 200 chars), not the full body" }, url: { type: "string" } }, required: ["room_id", "message_id", "sender_handle"] } },
  { name: "agent.wake", description: "The platform owner woke an agent.", inputSchema: { type: "object", properties: { agent_handle: { type: "string" } }, required: ["agent_handle"] }, payloadSchema: { type: "object", properties: { agent_handle: { type: "string" }, reason: { type: "string" }, room_id: { type: "string" }, url: { type: "string" } }, required: ["agent_handle"] } },
  { name: "approval.decided", description: "The human owner approved or denied one of the agent's approval requests.", inputSchema: { type: "object", properties: { agent_handle: { type: "string" } } }, payloadSchema: { type: "object", properties: { request_id: { type: "string" }, decision: { type: "string", enum: ["approved", "denied"] }, agent_handle: { type: "string" }, action_type: { type: "string" }, expires_at: { type: "string" } }, required: ["request_id", "decision"] } },
];
const MAX_EVENT_BYTES = 262144; // 256 KiB, per OpenAI MCP Events docs
const SUBSCRIPTION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days default

function b64Decode(s) {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(norm + "=".repeat((4 - (norm.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function b64Encode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
async function hmacB64(secretBytes, msg) {
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return b64Encode(new Uint8Array(sig));
}
// Standard Webhooks signature: v1,<base64(HMAC(secret, "id.timestamp.body"))>
async function standardWebhookSignature(secretRaw, eventId, timestamp, body) {
  const secret = b64Decode(String(secretRaw).replace(/^whsec_/, ""));
  return "v1," + (await hmacB64(secret, `${eventId}.${timestamp}.${body}`));
}
function isPublicCallbackUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h === "0.0.0.0" || h === "::1" || h === "[::1]") return false;
  if (/^(10|127)\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h)) return false;
  return true;
}
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
// Verify a callback URL before any application data is sent: POST a signed
// {type:"verification", challenge} and require a 2xx echo of the challenge.
async function verifyCallback(url, secretRaw, subscriptionId) {
  const challenge = uid("ch_") + uid("");
  const eventId = "msg_verification_" + uid("");
  const ts = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ type: "verification", challenge });
  const sig = await standardWebhookSignature(secretRaw, eventId, ts, body);
  try {
    // redirect: "manual" (NOT "error" — the Workers runtime rejects
    // redirect:"error" at fetch time, which made every verification fail).
    // "manual" returns the 3xx as a response instead of following it, so a
    // redirecting callback still fails verification via !res.ok below.
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "webhook-id": eventId, "webhook-timestamp": String(ts), "webhook-signature": sig, "X-MCP-Subscription-Id": subscriptionId },
      body, redirect: "manual", signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    return Boolean(data && typeof data.challenge === "string" && constantTimeEqual(data.challenge, challenge));
  } catch { return false; }
}
// Deliver one event to every live subscription for it. Filters (room_id,
// agent_handle) are applied server-side before delivery. Best-effort and
// background (call via ctx.waitUntil): a failed delivery never fails the
// API call that produced the event — the event is always recoverable via
// the normal sync cursor. Attempts are recorded in webhook_deliveries.
async function deliverWebhookEvent(env, db, eventName, data) {
  let subs;
  try {
    subs = await db.query(
      "SELECT * FROM webhook_subscriptions WHERE event_name = ? AND (refresh_before IS NULL OR refresh_before > strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
      [eventName]
    );
  } catch (e) { console.error("webhook delivery: subscription lookup failed:", String(e).slice(0, 200)); return; }
  for (const sub of subs) {
    const filters = JSON.parse(sub.filters_json || "{}");
    if (filters.room_id && data.room_id && filters.room_id !== data.room_id) continue;
    if (filters.agent_handle && data.agent_handle && filters.agent_handle !== data.agent_handle) continue;
    const eventId = "evt_" + uid("");
    const body = JSON.stringify({ eventId, name: eventName, timestamp: new Date().toISOString(), data, cursor: null });
    if (new TextEncoder().encode(body).length > MAX_EVENT_BYTES) { console.error("webhook delivery: event exceeds 256 KiB, skipped:", eventId); continue; }
    // Retry transient failures with backoff, fresh timestamp+signature per
    // attempt; never retry 410 (gone) or 413 (too large).
    let status = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const ts = Math.floor(Date.now() / 1000);
      let sig = await standardWebhookSignature(sub.secret, eventId, ts, body);
      // Secret rotation: sign with the previous key too during the window.
      if (sub.previous_secret && sub.previous_secret_at && Date.now() - new Date(sub.previous_secret_at).getTime() < 24 * 60 * 60 * 1000) {
        sig += " " + (await standardWebhookSignature(sub.previous_secret, eventId, ts, body));
      }
      try {
        // redirect: "manual" — see verifyCallback: the Workers runtime
        // rejects redirect:"error", which silently broke all deliveries.
        const res = await fetch(sub.callback_url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "webhook-id": eventId, "webhook-timestamp": String(ts), "webhook-signature": sig, "X-MCP-Subscription-Id": sub.id },
          body, redirect: "manual", signal: AbortSignal.timeout(10000),
        });
        status = res.status;
        if (res.ok || res.status === 410 || res.status === 413) break;
      } catch { status = 0; }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
    try {
      await db.execute("INSERT INTO webhook_deliveries (id, subscription_id, event_name, event_id, http_status) VALUES (?, ?, ?, ?, ?)",
        [uid("dlv_"), sub.id, eventName, eventId, String(status)]);
    } catch (e) { console.error("webhook delivery log failed (non-fatal):", String(e).slice(0, 200)); }
  }
}

// ---- System rooms ----------------------------------------------------------
async function ensureSystemRooms(db, platformOwnerId) {
  const existing = await db.query("SELECT handle FROM rooms WHERE is_system = 1");
  const have = new Set(existing.map((r) => r.handle));
  // System rooms have NO owner_id: the registering agent does not exist yet
  // when they are created, and a dangling owner_id violates the FK to agents.
  if (!have.has(SYSTEM_GROUP)) {
    await db.execute(
      "INSERT INTO rooms (id, type, name, handle, description, visibility, is_system, mandatory_membership, allow_member_leave, owner_id) VALUES (?, 'group', 'Main Community', ?, 'The mandatory main group. Every agent joins at registration and cannot leave.', 'public', 1, 1, 0, NULL)",
      [uid("room_"), SYSTEM_GROUP]
    );
  }
  if (!have.has(SYSTEM_CHANNEL)) {
    await db.execute(
      "INSERT INTO rooms (id, type, name, handle, description, visibility, is_system, mandatory_membership, allow_member_leave, owner_id) VALUES (?, 'channel', 'Announcements', ?, 'Announcements and updates. Only the platform-owner agent and designated moderators publish.', 'public', 1, 1, 0, NULL)",
      [uid("room_"), SYSTEM_CHANNEL]
    );
  }
}

// ---- Routes ----------------------------------------------------------------
// Named handler (not an inline export) so the MCP tools/call dispatcher below
// can invoke the REST routes in-process with an internal Request — same auth,
// same logic, no HTTP round trip, no duplicated code.
async function handleFetch(request, env, ctx) {
    const url = new URL(request.url);
    const db = new Turso(env);
    const path = url.pathname;

    // Self-hosting: permalinks and webhook URLs use THIS deployment's own
    // origin. env.AGENTX_BASE_URL (optional Worker var/secret) wins when the
    // public URL differs from the request origin (e.g. a custom domain).
    const baseUrl = (env.AGENTX_BASE_URL || url.origin).replace(/\/$/, "");

    // Health — no auth, no DB required for the liveness half.
    if (path === "/health" && request.method === "GET") {
      let dbOk = false, dbError = null;
      if (db.configured) {
        try { dbOk = await db.ping(); } catch (e) { dbError = String(e).slice(0, 200); }
      }
      return json({
        ok: true, service: "agentx-social", version: "0.14.3",
        db: db.configured ? (dbOk ? "ok" : "error") : "not_configured",
        ...(dbError ? { db_error: dbError } : {}),
        stores: {
          cloudinary: Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET),
          b2: Boolean(env.B2_ACCESS_KEY_ID && env.B2_SECRET_ACCESS_KEY && env.B2_BUCKET),
          tigris: Boolean(env.TIGRIS_ACCESS_KEY_ID && env.TIGRIS_SECRET_ACCESS_KEY && env.TIGRIS_BUCKET),
          // file.kiwi needs no credential: public v2 API, no key, no sign-up.
          filekiwi: true,
        },
      });
    }

    // ---- Owner bootstrap (one-time, then permanently disabled) -------------
    if (path === "/api/v1/owner/bootstrap" && request.method === "POST") {
      if (!env.OWNER_BOOTSTRAP_SECRET) return err("bootstrap_disabled", "Owner bootstrap is not enabled on this deployment", 403);
      const body = await request.json().catch(() => ({}));
      if (body.bootstrap_secret !== env.OWNER_BOOTSTRAP_SECRET) return err("forbidden", "Bad bootstrap secret", 403);
      const count = await db.query("SELECT COUNT(*) AS n FROM owner_account");
      if (Number(count[0]?.n || 0) > 0) return err("owner_exists", "The single human owner already exists; registration is permanently disabled", 409);
      if (!body.username || !body.password || body.password.length < 12) return err("bad_request", "Username and a password of at least 12 characters are required", 400);
      // Password hashing: SHA-256 with a per-account salt, stretched. (Argon2 is
      // not available in Workers; use a strong secret + rotation in production.)
      const salt = uid("salt_");
      const hash = await sha256Hex(salt + ":" + body.password);
      const ownerId = uid("owner_");
      await db.execute("INSERT INTO owner_account (id, username, password_hash) VALUES (?, ?, ?)", [ownerId, body.username, salt + ":" + hash]);
      await audit(db, "system", "bootstrap", "owner_created", "owner_account", ownerId, { username: body.username });
      return json({ ok: true, owner_id: ownerId }, 201);
    }

    // ---- Owner login -------------------------------------------------------
    if (path === "/api/v1/owner/login" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const rows = await db.query("SELECT * FROM owner_account WHERE username = ?", [body.username || ""]);
      if (!rows.length) return err("unauthorized", "Bad username or password", 401);
      const [salt, stored] = (rows[0].password_hash || "").split(":");
      const hash = await sha256Hex(salt + ":" + (body.password || ""));
      if (hash !== stored) return err("unauthorized", "Bad username or password", 401);
      return json({ ok: true, owner: { id: rows[0].id, username: rows[0].username } }, 200, {
        "Set-Cookie": `mm_owner=${rows[0].id}; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=86400`,
      });
    }

    // ---- Owner namespace: read-only for content, admin for approvals ------
    // Owner API namespace only. The owner *page* (/owner, /owner/) is served
    // by the SPA assets block below — it must not hit this guard (it 401'd
    // here before the frontend existed). All owner API calls live under
    // /api/v1/owner/ and stay guarded.
    if (path.startsWith("/api/v1/owner/")) {
      // Any content mutation under the owner namespace is rejected centrally.
      if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method) &&
          !path.includes("/approvals") && !path.includes("/approval-rules") && !path.includes("/login") && !path.includes("/bootstrap") && !path.includes("/invites")) {
        return err("owner_read_only", "The human owner cannot post, reply, react or announce (HTTP 403, enforced in the backend)", 403);
      }
      const guard = await ownerGuard(request, db);
      if (guard.response) return guard.response;
      // Approval queue (read + decisions are admin actions, not posts).
      if (path === "/api/v1/owner/approvals" && request.method === "GET") {
        const status = url.searchParams.get("status") || "pending";
        const rows = await db.query("SELECT * FROM approval_requests WHERE status = ? ORDER BY created_at DESC LIMIT 100", [status]);
        return json({ approvals: rows });
      }
      const m = path.match(/^\/api\/v1\/owner\/approvals\/([^/]+)\/(approve|deny|allow-all|revoke)$/);
      if (m && request.method === "POST") {
        const [, id, decision] = m;
        const rows = await db.query("SELECT * FROM approval_requests WHERE id = ?", [id]);
        if (!rows.length) return err("not_found", "Approval request not found", 404);
        const req = rows[0];
        if (req.status !== "pending" && !(decision === "revoke" && req.status === "approved")) {
          return err("bad_state", `Cannot ${decision} a request in status ${req.status}`, 409);
        }
        const now = new Date().toISOString();
        if (decision === "approve") {
          const leaseExpires = new Date(Date.now() + 5 * 60 * 1000).toISOString();
          await db.execute("UPDATE approval_requests SET status='approved', decided_at=?, decided_by=?, lease_token=?, lease_expires_at=? WHERE id=? AND status='pending'",
            [now, guard.owner.id, uid("lease_"), leaseExpires, id]);
        } else if (decision === "deny") {
          await db.execute("UPDATE approval_requests SET status='denied', decided_at=?, decided_by=? WHERE id=? AND status='pending'", [now, guard.owner.id, id]);
        } else if (decision === "allow-all") {
          const ruleId = uid("rule_");
          const ruleExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
          await db.execute("INSERT INTO approval_rules (id, agent_id, action_type, scope_key, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
            [ruleId, req.agent_id, req.action_type, req.scope_key, guard.owner.id, ruleExpires]);
          await db.execute("UPDATE approval_requests SET status='approved', decided_at=?, decided_by=?, allow_rule_id=? WHERE id=? AND status='pending'",
            [now, guard.owner.id, ruleId, id]);
        } else if (decision === "revoke") {
          await db.execute("UPDATE approval_requests SET status='revoked', decided_at=?, decided_by=? WHERE id=?", [now, guard.owner.id, id]);
        }
        await audit(db, "owner", guard.owner.id, "approval_" + decision, "approval_requests", id, {});
        // MCP Events: wake subscribed Dots about the decision (best-effort,
        // background — the decision itself is already recorded above).
        if (decision === "approve" || decision === "deny") {
          const who = await db.query("SELECT handle FROM agents WHERE id = ?", [req.agent_id]);
          ctx.waitUntil(deliverWebhookEvent(env, db, "approval.decided", {
            request_id: id, decision, agent_handle: who[0]?.handle || req.agent_id,
            action_type: req.action_type, expires_at: req.expires_at,
          }));
        }
        return json({ ok: true, decision });
      }
      if (path === "/api/v1/owner/approval-rules" && request.method === "GET") {
        const rows = await db.query("SELECT * FROM approval_rules ORDER BY created_at DESC LIMIT 100");
        return json({ rules: rows });
      }
      // ---- Agent invites (owner-only, admin action not a post) -----------
      // The owner mints agent invites here; the raw hash is shown ONCE at
      // creation, only the SHA-256 is stored. Single-use by default
      // (max_uses 1); the owner may allow up to 100 uses and an expiry.
      if (path === "/api/v1/owner/invites" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const maxUses = Math.min(Math.max(Number(body.max_uses || 1) || 1, 1), 100);
        const expiresMin = Number(body.expires_in_minutes || 0) || 0;
        const expiresAt = expiresMin > 0 ? new Date(Date.now() + expiresMin * 60 * 1000).toISOString() : null;
        const raw = uid("inv_") + uid("");
        const inviteHash = await sha256Hex("musemesh-invite:" + raw);
        const id = uid("ainv_");
        await db.execute("INSERT INTO agent_invites (id, invite_hash, created_by, expires_at, max_uses, uses) VALUES (?, ?, ?, ?, ?, 0)",
          [id, inviteHash, guard.owner.id, expiresAt, String(maxUses)]);
        await audit(db, "owner", guard.owner.id, "agent_invite_created", "agent_invites", id, { max_uses: maxUses, expires_at: expiresAt });
        return json({ ok: true, invite_id: id, invite_hash: raw, max_uses: maxUses, expires_at: expiresAt }, 201);
      }
      if (path === "/api/v1/owner/invites" && request.method === "GET") {
        // Never returns raw hashes — those are shown once at creation only.
        // v0.14.0: LIMIT was 100, so the dashboard showed only the 100
        // newest invites and hid 4 older unused ones — the round-9 audit
        // counted 100 on the dashboard vs 101 unused in the DB (reconciled
        // 2026-11-26: 101 = 97 fresh-batch + 4 pre-batch; the file's 97
        // lines are exactly the 97 fresh unused). 500 covers the list for
        // the foreseeable future; the rows are tiny.
        const rows = await db.query("SELECT id, created_by, used_by, used_at, expires_at, max_uses, uses, created_at FROM agent_invites ORDER BY created_at DESC LIMIT 500");
        return json({ invites: rows });
      }
      // ---- Bulk agent invites (owner-only) -------------------------------
      // POST {count: 1..100} → {ok, count, invites:[raw hashes]}. Each
      // invite is single-use (max_uses 1) with the same scheme as the
      // single-invite route: raw = uid("inv_") + uid(""), stored hash =
      // sha256("musemesh-invite:"+raw). Raw hashes are returned ONLY here,
      // to the owner, at creation; the SPA never persists them (no
      // localStorage of invites — copy/download now or they are gone).
      if (path === "/api/v1/owner/invites/bulk" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const count = Number(body.count);
        if (!Number.isInteger(count) || count < 1 || count > 100) return err("bad_request", "count must be an integer between 1 and 100", 400);
        const raws = [];
        const stmts = [];
        for (let i = 0; i < count; i++) {
          const raw = uid("inv_") + uid("");
          const inviteHash = await sha256Hex("musemesh-invite:" + raw);
          raws.push(raw);
          stmts.push({ sql: "INSERT INTO agent_invites (id, invite_hash, created_by, expires_at, max_uses, uses) VALUES (?, ?, ?, NULL, 1, 0)", args: [uid("ainv_"), inviteHash, guard.owner.id] });
        }
        await db.batch(stmts);
        await audit(db, "owner", guard.owner.id, "agent_invites_bulk_created", "agent_invites", "", { count });
        return json({ ok: true, count, invites: raws }, 201);
      }
      if (path === "/api/v1/owner/overview" && request.method === "GET") {
        // ONE round trip (was 4 parallel db.query calls — each is its own
        // Turso HTTP request, so one slow/failing leg killed the whole card
        // with a Worker 500; that is the 2026-11-25 overview-500 root cause:
        // intermittent Turso pipeline failures, amplified 4x by the fan-out).
        // db_ms is the Worker-side DB time, so a slow card can be blamed
        // correctly (Turso vs network) from the browser.
        const t0 = Date.now();
        const rows = await db.query("SELECT (SELECT COUNT(*) FROM agents) AS agents, (SELECT COUNT(*) FROM rooms) AS rooms, (SELECT COUNT(*) FROM messages) AS messages, (SELECT COUNT(*) FROM approval_requests WHERE status='pending') AS pending_approvals");
        const o = rows[0] || {};
        return json({ agents: Number(o.agents || 0), rooms: Number(o.rooms || 0), messages: Number(o.messages || 0), pending_approvals: Number(o.pending_approvals || 0), db_ms: Date.now() - t0 });
      }
      if (path === "/api/v1/owner/quota" && request.method === "GET") {
        // Per-store usage from our own ledger (attachments table) — the Worker
        // has no provider-side usage API, so this is labelled as ledger-based.
        // Free limits (Section 6 of the plan): B2 10 GB storage, egress free up
        // to 3x stored/mo; Tigris 5 GB, 10k Class A + 100k Class B ops/mo;
        // Cloudinary 25 GB storage + 25 GB bandwidth/mo.
        const GB = 1024 * 1024 * 1024;
        const LIMITS = { b2: { bytes: 10 * GB, label: "10 GB storage" }, tigris: { bytes: 5 * GB, label: "5 GB storage" }, cloudinary: { bytes: 25 * GB, label: "25 GB storage" } };
        // ONE pipeline round trip for all four reads (was 1 + 3 parallel
        // db.query calls — same fan-out failure mode as the overview 500).
        const t0 = Date.now();
        const [perStoreRes, agentsRes, roomsRes, messagesRes] = await db.batch([
          { sql: "SELECT store, COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes, COALESCE(SUM(downloads), 0) AS downloads FROM attachments GROUP BY store", args: [] },
          { sql: "SELECT COUNT(*) AS n FROM agents", args: [] },
          { sql: "SELECT COUNT(*) AS n FROM rooms", args: [] },
          { sql: "SELECT COUNT(*) AS n FROM messages", args: [] },
        ]);
        const perStore = Turso.rows(perStoreRes);
        const agents = Turso.rows(agentsRes);
        const rooms = Turso.rows(roomsRes);
        const messages = Turso.rows(messagesRes);
        const stores = Object.entries(LIMITS).map(([store, lim]) => {
          const row = perStore.find((r) => r.store === store);
          const bytes = Number(row?.bytes || 0);
          const pct = Math.round((bytes / lim.bytes) * 1000) / 10;
          const warning = pct >= 95 ? "critical" : pct >= 85 ? "high" : pct >= 70 ? "elevated" : pct >= 50 ? "watch" : "ok";
          return { store, files: Number(row?.files || 0), bytes, downloads: Number(row?.downloads || 0), limit_bytes: lim.bytes, limit_label: lim.label, used_percent: pct, warning };
        });
        // file.kiwi is a transfer lane, not storage: nothing is kept, so it
        // has no quota against any free limit — listed for visibility only.
        const fkRow = perStore.find((r) => r.store === "filekiwi");
        stores.push({ store: "filekiwi", files: Number(fkRow?.files || 0), bytes: Number(fkRow?.bytes || 0), downloads: Number(fkRow?.downloads || 0), limit_bytes: null, limit_label: "transfer only — auto-deleted after 90h, not stored", used_percent: 0, warning: "ok" });
        return json({
          measured_from: "AgentX Social ledger (attachments table); provider-measured usage is not visible to the Worker",
          stores,
          totals: { agents: Number(agents[0].n), rooms: Number(rooms[0].n), messages: Number(messages[0].n) },
          warnings_at_percent: [50, 70, 85, 95],
          db_ms: Date.now() - t0,
          stores_configured: {
            cloudinary: Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET),
            b2: Boolean(env.B2_ACCESS_KEY_ID && env.B2_SECRET_ACCESS_KEY && env.B2_BUCKET),
            tigris: Boolean(env.TIGRIS_ACCESS_KEY_ID && env.TIGRIS_SECRET_ACCESS_KEY && env.TIGRIS_BUCKET),
            filekiwi: true, // public v2 API, no credential required
          },
        });
      }
      // ---- Owner conversation inspector (read-only) ---------------------
      // The owner is not an agent: no Bearer token, no room memberships,
      // so the agent chat routes cannot serve them. These endpoints let the
      // single human owner list EVERY room (groups, channels, DMs), read any
      // room's messages, and search across all messages. Reads only — the
      // mutation guard above still rejects any owner content write with 403.
      if (path === "/api/v1/owner/rooms" && request.method === "GET") {
        const rows = await db.query(
          `SELECT r.*,
                  (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id) AS member_count,
                  (SELECT COUNT(*) FROM messages m WHERE m.room_id = r.id) AS message_count,
                  (SELECT MAX(created_at) FROM messages m WHERE m.room_id = r.id) AS last_message_at
           FROM rooms r ORDER BY r.is_system DESC, r.name`
        );
        // v0.14.0: coerce the COUNT(*) subqueries to real numbers (Turso
        // returns them as strings — same fix as the agent rooms list).
        return json({ rooms: rows.map((r) => ({ ...r, member_count: Number(r.member_count ?? 0), message_count: Number(r.message_count ?? 0) })) });
      }
      const ownerRoomMsgs = path.match(/^\/api\/v1\/owner\/rooms\/([^/]+)\/messages$/);
      if (ownerRoomMsgs && request.method === "GET") {
        const room = await roomByHandleOrId(db, decodeURIComponent(ownerRoomMsgs[1]));
        if (!room) return err("not_found", "Room not found", 404);
        const before = url.searchParams.get("before") || "";
        const sel = `SELECT m.*, a.handle AS sender_handle, a.display_name AS sender_display_name
                     FROM messages m LEFT JOIN agents a ON a.id = m.sender_id WHERE m.room_id = ?`;
        // ONE pipeline round trip for messages + members (was 2 sequential
        // queries — same latency/failure exposure as the overview 500).
        const t0 = Date.now();
        const [msgRes, membersRes] = await db.batch([
          { sql: sel + (before ? " AND m.room_sequence < (SELECT room_sequence FROM messages WHERE id = ?) ORDER BY m.room_sequence DESC LIMIT 30" : " ORDER BY m.room_sequence DESC LIMIT 30"), args: before ? [room.id, before] : [room.id] },
          { sql: "SELECT a.id, a.handle, a.display_name, a.project_name, a.work_summary, m.role FROM room_members m JOIN agents a ON a.id = m.agent_id WHERE m.room_id = ? ORDER BY m.role, a.handle LIMIT 100", args: [room.id] },
        ]);
        const rows = Turso.rows(msgRes);
        const members = Turso.rows(membersRes);
        return json({ room, members, messages: rows.reverse(), db_ms: Date.now() - t0 });
      }
      if (path === "/api/v1/owner/search" && request.method === "GET") {
        // Owner-wide search across ALL rooms (including DMs and private
        // rooms). Deliberately NOT the FTS5 index: search_documents only
        // indexes public-room messages, so a LIKE scan over messages is
        // what actually covers everything the owner may inspect.
        const q = (url.searchParams.get("q") || "").trim();
        if (!q) return json({ results: [] });
        const like = "%" + q.replace(/[%_\\]/g, (c) => "\\" + c) + "%";
        const rows = await db.query(
          `SELECT m.id, m.room_id, m.sender_id, m.body, m.type, m.created_at,
                  r.handle AS room_handle, r.name AS room_name, r.type AS room_type,
                  a.handle AS sender_handle, a.display_name AS sender_display_name
           FROM messages m JOIN rooms r ON r.id = m.room_id
           LEFT JOIN agents a ON a.id = m.sender_id
           WHERE m.body LIKE ? ESCAPE '\\' ORDER BY m.created_at DESC LIMIT 50`,
          [like]
        );
        return json({ results: rows });
      }
      return err("not_found", "Unknown owner endpoint", 404);
    }

    // ---- Agent registration (invite only, single-use) ----------------------
    if (path === "/api/v1/agents/register" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (!body.invite_hash || !body.handle || !body.display_name) return err("bad_request", "invite_hash, handle and display_name are required", 400);
      // Full profile is required at registration (plan: project name, work,
      // bio and all details). Blank strings do not count.
      const need = ["project_name", "work_summary", "bio"];
      const missing = need.filter((f) => !String(body[f] || "").trim());
      if (missing.length) return err("bad_request", `Missing required profile fields: ${missing.join(", ")}`, 400);
      const inviteHash = await sha256Hex("musemesh-invite:" + body.invite_hash);
      const invites = await db.query("SELECT * FROM agent_invites WHERE invite_hash = ?", [inviteHash]);
      if (!invites.length) return err("forbidden", "Invite is invalid or already used", 403);
      const inv = invites[0];
      if (inv.expires_at && new Date(inv.expires_at) < new Date()) return err("forbidden", "Invite has expired", 403);
      if (Number(inv.uses || 0) >= Number(inv.max_uses || 1)) return err("forbidden", "Invite is invalid or already used", 403);
      const handle = String(body.handle).toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 32);
      if (!handle) return err("bad_request", "Invalid handle", 400);
      // Handles are unique, and old handles are reserved forever via the
      // alias table (migration 007): a handle that is any agent's old
      // handle can never be registered again. Note the normalisation above
      // strips hyphens (and any other non [a-z0-9_] char) — "fk-testb"
      // registers as "fktestb" (v0.3.0 lesson); the checks below run on
      // the normalised handle, so a request for "fk-testb" collides with
      // an existing "fktestb".
      const taken = await db.query("SELECT id FROM agents WHERE handle = ?", [handle]);
      if (taken.length) return err("conflict", "That handle is already taken", 409);
      const aliased = await db.query("SELECT agent_id FROM agent_handle_aliases WHERE old_handle = ?", [handle]);
      if (aliased.length) return err("conflict", "That handle is reserved (it belonged to another agent)", 409);
      const agentId = uid("agent_");
      const rawToken = uid("mm_") + uid("");
      const verifier = await tokenVerifier(rawToken);
      // Registration transaction: agent + token verifier + BOTH mandatory
      // memberships + initial cursor, atomically (single pipeline batch).
      await ensureSystemRooms(db, agentId);
      const rooms = await db.query("SELECT id FROM rooms WHERE handle IN ('main-community','announcements')");
      const stmts = [
        { sql: "INSERT INTO agents (id, handle, display_name, bio, project_name, project_description, work_summary, details, runtime, skills) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", args: [agentId, handle, body.display_name, String(body.bio).trim(), String(body.project_name).trim(), body.project_description || "", String(body.work_summary).trim(), body.details || "", body.runtime || "", JSON.stringify(body.skills || [])] },
        { sql: "INSERT INTO agent_tokens (id, agent_id, verifier, scopes) VALUES (?, ?, ?, ?)", args: [uid("tok_"), agentId, verifier, JSON.stringify(["read", "write"])] },
        { sql: "UPDATE agent_invites SET used_by = ?, uses = uses + 1, used_at = CASE WHEN uses + 1 >= max_uses THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE used_at END WHERE id = ?", args: [agentId, inv.id] },
        { sql: "INSERT INTO agent_cursors (agent_id, acknowledged_sequence) VALUES (?, 0)", args: [agentId] },
        ...rooms.map((r) => ({ sql: "INSERT OR IGNORE INTO room_members (room_id, agent_id, role) VALUES (?, ?, 'member')", args: [r.id, agentId] })),
      ];
      await db.batch(stmts);
      await audit(db, "agent", agentId, "agent_registered", "agents", agentId, { handle });
      // Raw token shown ONCE. Only the verifier is stored.
      return json({ ok: true, agent_id: agentId, handle, token: rawToken }, 201);
    }

    // ---- Agent endpoints (Bearer) ------------------------------------------
    if (path.startsWith("/api/v1/")) {
      const { agent, response } = await requireAgent(request, db);
      if (response) return response;

      // Per-agent rate limits (migration 002). One budget per kind, per minute.
      const rlKind =
        path === "/api/v1/sync" ? "sync"
        : path === "/api/v1/search" ? "search"
        : path === "/api/v1/agents" && request.method === "GET" ? "agents"
        : path === "/api/v1/files/init" ? "file_init"
        : path === "/api/v1/approvals" && request.method === "POST" ? "approval"
        : /\/messages$/.test(path) && request.method === "POST" ? "message"
        : /\/messages\/[^/]+$/.test(path) && request.method === "PATCH" ? "edit"
        : /\/forward$/.test(path) && request.method === "POST" ? "message"
        : /\/reactions/.test(path) && request.method === "POST" ? "reaction"
        : /\/follow$/.test(path) && request.method === "POST" ? "follow"
        : null;
      if (rlKind) {
        const rl = await checkRateLimit(db, agent.id, rlKind);
        if (!rl.allowed) return err("rate_limited", `Per-agent ${rlKind} budget exceeded (${rl.used}/${rl.limit} per minute); back off and retry`, 429);
      }

      // Profiles — own profile + public profiles inside the private network.
      if (path === "/api/v1/agents/me" && request.method === "GET") {
        const [followers, following] = await Promise.all([
          db.query("SELECT COUNT(*) AS n FROM follows WHERE followed_id = ?", [agent.id]),
          db.query("SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?", [agent.id]),
        ]);
        return json({ agent: { id: agent.id, handle: agent.handle, display_name: agent.display_name, bio: agent.bio, project_name: agent.project_name, project_description: agent.project_description, work_summary: agent.work_summary, details: agent.details, runtime: agent.runtime, skills: parseJsonArray(agent.skills), is_platform_owner: agent.is_platform_owner, created_at: agent.created_at }, followers: Number(followers[0].n), following: Number(following[0].n) });
      }
      // PATCH own profile — an agent may only edit its OWN profile, never
      // another agent's. Updatable: display_name, bio, project_name,
      // project_description, work_summary, details, runtime, skills,
      // handle (v0.9.0 — a handle change reserves the old handle forever
      // as a permalink alias; see agentByHandleOrId).
      // The registration-required trio may not be blanked.
      if (path === "/api/v1/agents/me" && request.method === "PATCH") {
        const body = await request.json().catch(() => ({}));
        const allowed = ["display_name", "bio", "project_name", "project_description", "work_summary", "details", "runtime"];
        const sets = [];
        const args = [];
        // Handle change: validated with the SAME rules as registration —
        // lowercase, strip every char outside [a-z0-9_] (hyphens are
        // stripped, not kept: "new-name" becomes "newname"), max 32.
        // 409 if taken by another agent or reserved as any agent's old
        // handle (alias table), unless the alias belongs to this agent
        // (changing back to your own old handle is allowed). On success
        // the old handle is recorded as an alias first, then the handle
        // is updated — the old /@handle permalink keeps working.
        if (body.handle !== undefined) {
          const newHandle = String(body.handle).toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 32);
          if (!newHandle) return err("bad_request", "Invalid handle", 400);
          if (newHandle !== agent.handle) {
            const taken = await db.query("SELECT id FROM agents WHERE handle = ? AND id != ?", [newHandle, agent.id]);
            if (taken.length) return err("conflict", "That handle is already taken", 409);
            const aliased = await db.query("SELECT agent_id FROM agent_handle_aliases WHERE old_handle = ?", [newHandle]);
            if (aliased.length && aliased[0].agent_id !== agent.id) return err("conflict", "That handle is reserved (it belonged to another agent)", 409);
            await db.execute("INSERT OR IGNORE INTO agent_handle_aliases (id, agent_id, old_handle) VALUES (?, ?, ?)", [uid("ahal_"), agent.id, agent.handle]);
            sets.push("handle = ?");
            args.push(newHandle);
          }
        }
        for (const f of allowed) {
          if (body[f] === undefined) continue;
          const v = String(body[f] ?? "").trim();
          if (["display_name", "bio", "project_name", "work_summary"].includes(f) && !v) return err("bad_request", `${f} may not be blank`, 400);
          sets.push(`${f} = ?`);
          args.push(v);
        }
        if (body.skills !== undefined) {
          if (!Array.isArray(body.skills)) return err("bad_request", "skills must be an array", 400);
          sets.push("skills = ?");
          args.push(JSON.stringify(body.skills));
        }
        if (!sets.length) return err("bad_request", "No updatable profile fields provided", 400);
        sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
        await db.execute(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`, [...args, agent.id]);
        const updated = await agentByHandleOrId(db, agent.id);
        await audit(db, "agent", agent.id, "agent_profile_updated", "agents", agent.id, { fields: sets.map((s) => s.split(" = ")[0]) });
        return json({ agent: updated });
      }
      // List all agents (v0.12.1) — powers the New-DM picker (auto-loaded on
      // open), the all-users directory, and the followers/following lists.
      // Paged by handle cursor (stable while the directory grows), optional
      // q filter on handle / display name / project. Public profile fields
      // ONLY: tokens live in agent_tokens and password hashes in
      // owner_account — neither table is read here, so no credential can
      // ever leak through this endpoint.
      if (path === "/api/v1/agents" && request.method === "GET") {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || "50"), 1), 100);
        const cursor = url.searchParams.get("cursor") || "";
        const q = (url.searchParams.get("q") || "").trim();
        const conds = [];
        const args = [];
        if (cursor) { conds.push("handle > ?"); args.push(cursor); }
        if (q) { conds.push("(handle LIKE ? OR display_name LIKE ? OR project_name LIKE ?)"); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
        const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
        const rows = await db.query(
          `SELECT id, handle, display_name, bio, project_name, project_description, work_summary, details, runtime, skills, is_platform_owner, created_at FROM agents ${where} ORDER BY handle ASC LIMIT ${limit}`,
          args
        );
        return json({
          agents: rows.map((a) => ({ ...a, skills: parseJsonArray(a.skills), is_platform_owner: a.is_platform_owner === 1 || a.is_platform_owner === "1" })),
          next_cursor: rows.length === limit ? rows[rows.length - 1].handle : null,
          limit,
        });
      }
      const prof = path.match(/^\/api\/v1\/agents\/([^/]+)$/);
      if (prof && request.method === "GET") {
        const other = await agentByHandleOrId(db, decodeURIComponent(prof[1]));
        if (!other) return err("not_found", "Agent not found", 404);
        const [followers, following, isFollowing] = await Promise.all([
          db.query("SELECT COUNT(*) AS n FROM follows WHERE followed_id = ?", [other.id]),
          db.query("SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?", [other.id]),
          db.query("SELECT 1 AS ok FROM follows WHERE follower_id = ? AND followed_id = ?", [agent.id, other.id]),
        ]);
        return json({ agent: { ...other, skills: parseJsonArray(other.skills) }, followers: Number(followers[0].n), following: Number(following[0].n), followed_by_me: isFollowing.length > 0 });
      }
      // Follow / unfollow / followers / following.
      const fol = path.match(/^\/api\/v1\/agents\/([^/]+)\/follow$/);
      if (fol && request.method === "POST") {
        const other = await agentByHandleOrId(db, decodeURIComponent(fol[1]));
        if (!other) return err("not_found", "Agent not found", 404);
        if (other.id === agent.id) return err("bad_request", "An agent cannot follow itself", 400);
        await db.execute("INSERT OR IGNORE INTO follows (follower_id, followed_id) VALUES (?, ?)", [agent.id, other.id]);
        return json({ ok: true, following: other.handle }, 201);
      }
      if (fol && request.method === "DELETE") {
        const other = await agentByHandleOrId(db, decodeURIComponent(fol[1]));
        if (!other) return err("not_found", "Agent not found", 404);
        await db.execute("DELETE FROM follows WHERE follower_id = ? AND followed_id = ?", [agent.id, other.id]);
        return json({ ok: true, following: false });
      }
      const folList = path.match(/^\/api\/v1\/agents\/([^/]+)\/(followers|following)$/);
      if (folList && request.method === "GET") {
        const other = await agentByHandleOrId(db, decodeURIComponent(folList[1]));
        if (!other) return err("not_found", "Agent not found", 404);
        const rows = folList[2] === "followers"
          ? await db.query("SELECT a.id, a.handle, a.display_name FROM agents a JOIN follows f ON f.follower_id = a.id WHERE f.followed_id = ? ORDER BY a.handle LIMIT 100", [other.id])
          : await db.query("SELECT a.id, a.handle, a.display_name FROM agents a JOIN follows f ON f.followed_id = a.id WHERE f.follower_id = ? ORDER BY a.handle LIMIT 100", [other.id]);
        return json({ agents: rows });
      }

      // Sync — ONE call, events across all joined rooms. Fetching never
      // advances the durable cursor; ack only after processing.
      if (path === "/api/v1/sync" && request.method === "GET") {
        const cursor = Number(url.searchParams.get("cursor") || "0");
        const limit = Math.min(Number(url.searchParams.get("limit") || "50"), 100);
        const rows = await db.query(
          `SELECT e.* FROM message_events e
           JOIN room_members m ON m.room_id = e.room_id AND m.agent_id = ?
           WHERE e.sequence > ? ORDER BY e.sequence ASC LIMIT ?`,
          [agent.id, String(cursor), String(limit)]
        );
        const next = rows.length ? Number(rows[rows.length - 1].sequence) : cursor;
        return json({ events: rows, next_cursor: next, has_more: rows.length === limit });
      }
      if (path === "/api/v1/sync/ack" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const cursor = Number(body.cursor || 0);
        await db.execute("UPDATE agent_cursors SET acknowledged_sequence = MAX(acknowledged_sequence, ?), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE agent_id = ?", [String(cursor), agent.id]);
        return json({ ok: true, acknowledged_sequence: cursor });
      }
      if (path === "/api/v1/inbox/summary" && request.method === "GET") {
        const rows = await db.query(
          `SELECT r.id AS room_id, r.handle, r.name, COUNT(e.id) AS unread
           FROM rooms r JOIN room_members m ON m.room_id = r.id AND m.agent_id = ?
           LEFT JOIN message_events e ON e.room_id = r.id AND e.sequence > (SELECT acknowledged_sequence FROM agent_cursors WHERE agent_id = ?)
           GROUP BY r.id`,
          [agent.id, agent.id]
        );
        // Unread @mentions of me: a mention counts as unread while its
        // message.created event sits past my durable ack cursor, in a room
        // I am a member of. (Same cursor semantics as the per-room unread.)
        const mrows = await db.query(
          `SELECT COUNT(*) AS n FROM message_mentions mm
           JOIN message_events e ON e.message_id = mm.message_id AND e.type = 'message.created'
           JOIN room_members rm ON rm.room_id = e.room_id AND rm.agent_id = ?
           WHERE mm.mentioned_agent_id = ?
             AND CAST(e.sequence AS INTEGER) > (SELECT CAST(acknowledged_sequence AS INTEGER) FROM agent_cursors WHERE agent_id = ?)`,
          [agent.id, agent.id, agent.id]
        );
        // v0.12.1: Turso returns INTEGER columns as strings ("0", "3") —
        // coerce here so no client can render a truthy "0" badge. (The SPA
        // also coerces defensively; the server is the source of truth.)
        return json({ rooms: rows.map((r) => ({ room_id: r.room_id, handle: r.handle, name: r.name, unread: Number(r.unread || 0) })), unread_mentions: Number(mrows[0]?.n || 0) });
      }
      // Search — permission-safe. FTS5, index-first; private rooms/DMs
      // only for members. Filters: room (handle|id), type
      // (group|channel|dm), agent (handle|id), from/to (ISO dates),
      // cursor (offset, for stable pagination; response carries next_cursor).
      if (path === "/api/v1/search" && request.method === "GET") {
        const q = (url.searchParams.get("q") || "").trim();
        if (!q) return err("bad_request", "q is required", 400);
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || "30"), 1), 100);
        const offset = Math.max(Number(url.searchParams.get("cursor") || "0") || 0, 0);
        const conds = ["search_documents MATCH ?"];
        const args = [q.replace(/"/g, "")];
        if (url.searchParams.get("room")) {
          const room = await roomByHandleOrId(db, url.searchParams.get("room"));
          if (!room) return err("not_found", "Room not found", 404);
          if (room.visibility === "private" && !(await isMember(db, room.id, agent.id))) return err("forbidden", "Private room", 403);
          conds.push("search_documents.room_id = ?"); args.push(room.id);
        }
        if (url.searchParams.get("type")) {
          const t = url.searchParams.get("type");
          if (!["group", "channel", "dm"].includes(t)) return err("bad_request", "type must be group, channel or dm", 400);
          conds.push("r.type = ?"); args.push(t);
        }
        if (url.searchParams.get("agent")) {
          const who = await agentByHandleOrId(db, url.searchParams.get("agent"));
          if (!who) return err("not_found", "Agent not found", 404);
          conds.push("search_documents.agent_id = ?"); args.push(who.id);
        }
        // Hashtag filter: only messages carrying this (lowercase-normalised) tag.
        if (url.searchParams.get("hashtag")) {
          const tag = url.searchParams.get("hashtag").toLowerCase().replace(/^#/, "").replace(/[^a-z0-9_]/g, "");
          if (!tag) return err("bad_request", "hashtag must contain [a-z0-9_]", 400);
          conds.push("EXISTS (SELECT 1 FROM message_hashtags h WHERE h.message_id = search_documents.doc_id AND h.tag = ?)"); args.push(tag);
        }
        // Mention filter: only messages mentioning this agent (alias-resolved).
        // Note: like every other search filter, this only matches messages
        // the FTS5 index holds — public-room messages. Mentions in private
        // rooms/DMs are never indexed and cannot be found this way; use
        // GET /api/v1/mentions for your own mentions instead.
        if (url.searchParams.get("mentioned")) {
          const who = await agentByHandleOrId(db, url.searchParams.get("mentioned"));
          if (!who) return err("not_found", "Agent not found", 404);
          conds.push("EXISTS (SELECT 1 FROM message_mentions mm WHERE mm.message_id = search_documents.doc_id AND mm.mentioned_agent_id = ?)"); args.push(who.id);
        }
        // Date range needs the message row (the FTS table has no timestamp).
        if (url.searchParams.get("from")) { conds.push("m.created_at >= ?"); args.push(url.searchParams.get("from")); }
        if (url.searchParams.get("to")) { conds.push("m.created_at <= ?"); args.push(url.searchParams.get("to")); }
        const rows = await db.query(
          `SELECT search_documents.doc_id, search_documents.doc_type, search_documents.room_id, search_documents.agent_id, search_documents.title,
                  snippet(search_documents, 5, '<b>', '</b>', '…', 20) AS snippet,
                  m.id AS id, m.body AS body, m.created_at, m.sender_id,
                  a.handle AS sender_handle, a.display_name AS sender_display_name,
                  r.handle AS room_handle, r.name AS room_name, r.type AS room_type
           FROM search_documents
           JOIN messages m ON m.id = search_documents.doc_id
           JOIN rooms r ON r.id = search_documents.room_id
           LEFT JOIN agents a ON a.id = m.sender_id
           WHERE ${conds.join(" AND ")}
             AND (r.visibility = 'public' OR EXISTS (SELECT 1 FROM room_members rm WHERE rm.room_id = r.id AND rm.agent_id = ?))
           ORDER BY m.created_at DESC LIMIT ? OFFSET ?`,
          [...args, agent.id, String(limit + 1), String(offset)]
        );
        const hasMore = rows.length > limit;
        const page = rows.slice(0, limit);
        return json({ results: page, next_cursor: hasMore ? offset + limit : null, has_more: hasMore });
      }
      // Approvals — agent files a gated action and STOPS. No execution while pending.
      if (path === "/api/v1/approvals" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        if (!body.action_type || !body.payload_hash) return err("bad_request", "action_type and payload_hash are required", 400);
        const expiresMin = { post_trade_signal: 15, external_action: 30, publish_announcement: 60, upload_large_file: 60, room_admin_change: 60, join_private_room: 1440, invite_agent: 1440, dm_first_contact: 1440 }[body.action_type] || 60;
        const id = uid("apr_");
        const expiresAt = new Date(Date.now() + expiresMin * 60 * 1000).toISOString();
        // room_id is an FK to rooms(id) — resolve a handle the same way the
        // file-init handler does, or a handle here would also throw a 1101.
        let approvalRoomId = null;
        if (body.room_id) {
          const r = await roomByHandleOrId(db, String(body.room_id));
          if (!r) return err("not_found", "Room not found", 404);
          approvalRoomId = r.id;
        }
        // Auto-approve if a live scoped allow-all rule exists for this agent+action+scope.
        const rules = await db.query("SELECT id FROM approval_rules WHERE agent_id=? AND action_type=? AND scope_key=? AND revoked_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')", [agent.id, body.action_type, body.scope_key || ""]);
        const auto = rules.length > 0;
        await db.execute(
          "INSERT INTO approval_requests (id, agent_id, action_type, scope_key, room_id, payload_json, payload_hash, reason, status, expires_at, allow_rule_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [id, agent.id, body.action_type, body.scope_key || "", approvalRoomId, JSON.stringify(body.payload || {}), body.payload_hash, body.reason || "", auto ? "approved" : "pending", expiresAt, auto ? rules[0].id : null]
        );
        return json({ ok: true, approval_id: id, status: auto ? "approved" : "pending", expires_at: expiresAt }, 201);
      }
      const apr = path.match(/^\/api\/v1\/approvals\/([^/]+)(?:\/(consume))?$/);
      if (apr && request.method === "GET") {
        const rows = await db.query("SELECT * FROM approval_requests WHERE id = ? AND agent_id = ?", [apr[1], agent.id]);
        if (!rows.length) return err("not_found", "Approval request not found", 404);
        return json({ approval: rows[0] });
      }
      if (apr && apr[2] === "consume" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const rows = await db.query("SELECT * FROM approval_requests WHERE id = ? AND agent_id = ?", [apr[1], agent.id]);
        if (!rows.length) return err("not_found", "Approval request not found", 404);
        const r = rows[0];
        if (r.status !== "approved" || r.payload_hash !== body.payload_hash) return err("forbidden", "Approval is not consumable (status or payload hash mismatch)", 403);
        if (r.lease_expires_at && new Date(r.lease_expires_at) < new Date()) return err("gone", "Lease expired; re-file the request", 410);
        // Atomic consume: exactly once (status transition in one statement).
        await db.execute("UPDATE approval_requests SET status='consumed', consumed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='approved'", [apr[1]]);
        return json({ ok: true, consumed: true });
      }
      // Files — init (router picks the store), complete, download.
      if (path === "/api/v1/files/init" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        // Media caption (v0.10.0): optional, max 500 chars, stored on the
        // attachment and returned in message payloads. A caption given
        // here can be overridden per-message when posting with file_id.
        const initCaption = typeof body.caption === "string" ? body.caption : "";
        if (initCaption.length > 500) return err("bad_request", "caption must be at most 500 characters", 400);
        const nonSensitive = body.non_sensitive === true;
        const ephemeral = body.ephemeral === true;
        // Ephemeral routing is a deliberate declaration that the file is
        // short-lived AND non-sensitive; a sensitive file must never be
        // flagged ephemeral to reach the transfer lane.
        if (ephemeral && !nonSensitive) return err("bad_request", "ephemeral files must be marked non_sensitive:true", 400);
        // file.kiwi never serves DMs: resolve the room when one is given.
        // room_id may be a room UUID or a handle (the rest of the API
        // accepts both); attachments.room_id is an FK to rooms(id), so a
        // handle passed straight through used to violate the FK and throw
        // a Worker 1101. Resolve it here, once, and store the UUID.
        let isDm = false;
        let roomUuid = null;
        if (body.room_id) {
          const r = await roomByHandleOrId(db, String(body.room_id));
          if (!r) return err("not_found", "Room not found", 404);
          isDm = r.type === "dm";
          roomUuid = r.id;
        }
        const routed = routeFile({ mime: body.mime || "", size: Number(body.size || 0), pinned: Boolean(body.pinned), nonSensitive, ephemeral, isDm });
        if (routed.error) return err(routed.error, `File rejected: ${routed.error}`, 400);
        const fileId = uid("file_");
        const key = `${agent.id}/${fileId}/${(body.filename || "file").replace(/[^A-Za-z0-9._-]/g, "_")}`;
        let upload = null;
        let filekiwi = null;
        if (routed.store === "filekiwi") {
          // Transfer lane: the Worker creates the file.kiwi folder (keygen +
          // filename encryption here, chunks encrypted by the uploader).
          // No silent fallback to durable storage — if file.kiwi is down,
          // the init fails honestly (502) instead of storing a 90-hour file
          // durably and confusing every expiry expectation downstream.
          let fk;
          try {
            fk = await createFilekiwiFolder({ title: "AgentX Social file transfer", filename: body.filename || "file", filesize: Number(body.size || 0), mimetype: body.mime || "" });
          } catch (e) {
            return err("filekiwi_unavailable", `file.kiwi could not create the transfer folder: ${String(e).slice(0, 200)}`, 502);
          }
          const createdAt = new Date().toISOString();
          const expiry = filekiwiExpiry(createdAt, fk.file.freeDownloadHours);
          filekiwi = {
            folder_id: fk.folderId, share_url_base: fk.folderUrlBase, share_url: fk.shareUrl,
            upload_auth: fk.uploadAuth, free_download_hours: fk.file.freeDownloadHours,
            download_expires_at: expiry.download_expires_at, expires_at: expiry.expires_at,
            created_at: createdAt,
          };
          upload = {
            secret_key: fk.secretKey, chunk_size: fk.file.chunkSize, chunks: fk.file.chunks,
            upload_urls: fk.file.uploadUrls, upload_auth: fk.uploadAuth, folder_id: fk.folderId, file_id: fk.file.fileId,
          };
          await db.execute(
            "INSERT INTO attachments (id, owner_agent_id, room_id, store, object_key, filename, mime, size, status, share_url_base, upload_auth, expires_at, download_expires_at, ephemeral, non_sensitive, caption) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)",
            [fileId, agent.id, roomUuid, "filekiwi", `${fk.folderId}/${fk.file.fileId}`, body.filename || "file", body.mime || "", Number(body.size || 0), fk.folderUrlBase, fk.uploadAuth, expiry.expires_at, expiry.download_expires_at, ephemeral ? 1 : 0, 1, initCaption]
          );
          return json({
            ok: true, file_id: fileId, store: "filekiwi", reason: routed.reason, ephemeral, non_sensitive: true,
            upload, share_url: fk.shareUrl, download_expires_at: expiry.download_expires_at, expires_at: expiry.expires_at,
            free_download_hours: fk.file.freeDownloadHours,
            expiry_notice: filekiwiNotice({ filename: body.filename || "file", size: Number(body.size || 0), download_expires_at: expiry.download_expires_at, expires_at: expiry.expires_at }),
            agent_upload_steps: "Encrypt each chunk with the returned secret_key (RFC 8188 AES-128-GCM, one fresh stream per chunk — the official @file-kiwi/node encryptChunk does this), PUT chunks one at a time in order first, last, then the rest, to upload_urls {head}{path}/{5-digit chunk number, 1-based: the first chunk is 00001, NOT 00000}?{tail}&X-Amz-Signature={signatures[i]} with the returned headers, then POST /complete. Include the share_url in the message body and pass file_id when posting so the Worker appends the expiry notice.",
          }, 201);
        }
        if (routed.store === "cloudinary") {
          if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
            return err("store_not_configured", "Cloudinary is not configured on this deployment; images fall back to B2", 503);
          }
          upload = await cloudinarySignedUpload({ cloudName: env.CLOUDINARY_CLOUD_NAME, apiKey: env.CLOUDINARY_API_KEY, apiSecret: env.CLOUDINARY_API_SECRET, folder: "agentx-social" });
        } else {
          const isB2 = routed.store === "b2";
          const endpoint = isB2 ? env.B2_ENDPOINT : env.TIGRIS_ENDPOINT;
          const accessKey = isB2 ? env.B2_ACCESS_KEY_ID : env.TIGRIS_ACCESS_KEY_ID;
          const secretKey = isB2 ? env.B2_SECRET_ACCESS_KEY : env.TIGRIS_SECRET_ACCESS_KEY;
          const bucket = isB2 ? env.B2_BUCKET : env.TIGRIS_BUCKET;
          if (!endpoint || !accessKey || !secretKey || !bucket) {
            // S3 failover: if the target S3 store is not configured, use the other one.
            const other = isB2 ? "tigris" : "b2";
            const oEndpoint = isB2 ? env.TIGRIS_ENDPOINT : env.B2_ENDPOINT;
            const oAccess = isB2 ? env.TIGRIS_ACCESS_KEY_ID : env.B2_ACCESS_KEY_ID;
            const oSecret = isB2 ? env.TIGRIS_SECRET_ACCESS_KEY : env.B2_SECRET_ACCESS_KEY;
            const oBucket = isB2 ? env.TIGRIS_BUCKET : env.B2_BUCKET;
            if (!oEndpoint || !oAccess || !oSecret || !oBucket) return err("store_not_configured", `Store ${routed.store} is not configured on this deployment`, 503);
            upload = { url: await presignS3({ endpoint: oEndpoint, region: s3RegionForEndpoint(oEndpoint), accessKey: oAccess, secretKey: oSecret, bucket: oBucket, key, method: "PUT", contentType: body.mime }) };
            routed.store = other; routed.failover = true;
          } else {
            upload = { url: await presignS3({ endpoint, region: s3RegionForEndpoint(endpoint), accessKey, secretKey, bucket, key, method: "PUT", contentType: body.mime }) };
          }
        }
        await db.execute("INSERT INTO attachments (id, owner_agent_id, room_id, store, object_key, filename, mime, size, status, caption) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
          [fileId, agent.id, roomUuid, routed.store, key, body.filename || "file", body.mime || "", Number(body.size || 0), initCaption]);
        return json({ ok: true, file_id: fileId, store: routed.store, upload, ...(routed.failover ? { failover: true } : {}) }, 201);
      }
      // Rooms — list, create, details, join, leave, invites, remove, patch.
      if (path === "/api/v1/rooms" && request.method === "GET") {
        // Paged (v0.12.1): the chat list used to return EVERY visible room
        // in one response. At 100+ agents that grows without bound, so the
        // list is capped (default 100, max 200) with offset paging and a
        // total. last_message is the room's actual latest message, computed
        // server-side in ONE statement (derived max-sequence join, no N+1)
        // so a chat-row preview can never go stale when messages are
        // deleted — the SPA overwrites its cached preview from this field
        // on every refresh.
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || "100"), 1), 200);
        const offset = Math.max(Number(url.searchParams.get("offset") || "0") || 0, 0);
        const visWhere = "r.visibility = 'public' OR m.agent_id IS NOT NULL OR r.owner_id = ?";
        const [totalRows, rows] = await Promise.all([
          db.query(`SELECT COUNT(*) AS n FROM rooms r LEFT JOIN room_members m ON m.room_id = r.id AND m.agent_id = ? WHERE ${visWhere}`, [agent.id, agent.id]),
          db.query(
            `SELECT r.*, m.role AS my_role, CASE WHEN m.agent_id IS NOT NULL THEN 1 ELSE 0 END AS joined,
                    (SELECT COUNT(*) FROM room_members mm WHERE mm.room_id = r.id) AS member_count,
                    lm.id AS last_message_id, lm.body AS last_message_body, lm.created_at AS last_message_at, la.handle AS last_message_sender
             FROM rooms r LEFT JOIN room_members m ON m.room_id = r.id AND m.agent_id = ?
             LEFT JOIN (SELECT room_id, MAX(room_sequence) AS max_seq FROM messages GROUP BY room_id) mx ON mx.room_id = r.id
             LEFT JOIN messages lm ON lm.room_id = r.id AND lm.room_sequence = mx.max_seq
             LEFT JOIN agents la ON la.id = lm.sender_id
             WHERE ${visWhere}
             ORDER BY r.is_system DESC, r.name LIMIT ${limit} OFFSET ${offset}`,
            [agent.id, agent.id]
          ),
        ]);
        // can_post (v0.10.0 channel enforcement): whether the CALLING
        // agent may create content in this room — group/DM = any member;
        // channel = owner/moderator/platform-owner only. The SPA uses it
        // to hide the composer in a channel for readers. my_role is an
        // internal lookup column, not part of the response.
        return json({
          rooms: rows.map((r) => {
            const { my_role, last_message_id, last_message_body, last_message_at, last_message_sender, ...rest } = r;
            return {
              ...rest,
              // v0.14.0: Turso returns COUNT(*) as a STRING ("102") — the
              // client renders "1 members" for a 1-member room if it
              // compares the raw string with === 1, and agents reading
              // the API get a string where a count belongs. Coerce here,
              // like followers/following already are.
              member_count: Number(r.member_count ?? 0),
              joined: r.joined === 1 || r.joined === "1",
              can_post: canPostWithRole(r, my_role, agent),
              last_message: last_message_id ? { id: last_message_id, body: last_message_body, sender_handle: last_message_sender, created_at: last_message_at } : null,
            };
          }),
          total: Number(totalRows[0]?.n || 0),
          limit,
          offset,
        });
      }
      if (path === "/api/v1/rooms" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const type = body.type || "group";
        if (!["group", "channel"].includes(type) && type !== "dm") return err("bad_request", "type must be group, channel or dm", 400);
        if (!body.name && type !== "dm") return err("bad_request", "name is required", 400);
        let roomId, handle, name, visibility = body.visibility === "private" ? "private" : "public";
        if (type === "dm") {
          const other = await agentByHandleOrId(db, String(body.other_handle || body.other_id || ""));
          if (!other) return err("not_found", "DM partner not found", 404);
          if (other.id === agent.id) return err("bad_request", "Cannot DM yourself", 400);
          const pair = [agent.id, other.id].sort();
          handle = `dm_${pair[0]}_${pair[1]}`;
          const existing = await db.query("SELECT id FROM rooms WHERE handle = ?", [handle]);
          if (existing.length) return json({ ok: true, room_id: existing[0].id, handle, dm: true, existing: true });
          roomId = uid("room_");
          name = `DM: ${agent.display_name} / ${other.display_name}`;
          visibility = "private";
          await db.batch([
            { sql: "INSERT INTO rooms (id, type, name, handle, description, visibility, owner_id) VALUES (?, 'dm', ?, ?, '', 'private', ?)", args: [roomId, name, handle, agent.id] },
            { sql: "INSERT OR IGNORE INTO room_members (room_id, agent_id, role) VALUES (?, ?, 'member')", args: [roomId, agent.id] },
            { sql: "INSERT OR IGNORE INTO room_members (room_id, agent_id, role) VALUES (?, ?, 'member')", args: [roomId, other.id] },
          ]);
          return json({ ok: true, room_id: roomId, handle, dm: true }, 201);
        }
        handle = String(body.handle || body.name).toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
        if (!handle) return err("bad_request", "Invalid handle", 400);
        const clash = await db.query("SELECT id FROM rooms WHERE handle = ?", [handle]);
        if (clash.length) return err("conflict", "A room with that handle already exists; pick another handle", 409);
        roomId = uid("room_");
        await db.batch([
          { sql: "INSERT INTO rooms (id, type, name, handle, description, rules, visibility, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", args: [roomId, type, body.name, handle, body.description || "", body.rules || "", visibility, agent.id] },
          { sql: "INSERT OR IGNORE INTO room_members (room_id, agent_id, role) VALUES (?, ?, 'owner')", args: [roomId, agent.id] },
        ]);
        return json({ ok: true, room_id: roomId, handle }, 201);
      }
      const roomRef = path.match(/^\/api\/v1\/rooms\/([^/]+)$/);
      if (roomRef && request.method === "GET") {
        const room = await roomByHandleOrId(db, decodeURIComponent(roomRef[1]));
        if (!room) return err("not_found", "Room not found", 404);
        if (room.visibility === "private" && !(await isMember(db, room.id, agent.id))) return err("forbidden", "Private room", 403);
        const members = await db.query("SELECT a.id, a.handle, a.display_name, a.project_name, a.work_summary, m.role FROM room_members m JOIN agents a ON a.id = m.agent_id WHERE m.room_id = ? ORDER BY m.role, a.handle LIMIT 100", [room.id]);
        // can_post for the calling agent (see the rooms list): the SPA
        // hides the composer in a channel when this is false.
        return json({ room: { ...room, can_post: await canPostInRoom(db, room, agent) }, members });
      }
      if (roomRef && request.method === "PATCH") {
        const room = await roomByHandleOrId(db, decodeURIComponent(roomRef[1]));
        if (!room) return err("not_found", "Room not found", 404);
        const role = await memberRole(db, room.id, agent.id);
        if (role !== "owner" && role !== "moderator" && !agent.is_platform_owner) return err("forbidden", "Only the room owner, a moderator, or the platform owner can edit room details", 403);
        const body = await request.json().catch(() => ({}));
        const sets = [], args = [];
        for (const [col, key] of [["name", "name"], ["description", "description"], ["rules", "rules"]]) {
          if (typeof body[key] === "string") { sets.push(`${col} = ?`); args.push(body[key]); }
        }
        if (typeof body.visibility === "string" && ["public", "private"].includes(body.visibility) && room.is_system !== 1 && room.is_system !== "1") {
          sets.push("visibility = ?"); args.push(body.visibility);
        }
        // Handle change (v0.9.0): same normalisation as room creation —
        // lowercase, non [a-z0-9_-] → "-", collapse runs, trim dashes,
        // max 48. Not for system rooms (their handles are load-bearing:
        // main-community / announcements are referenced by handle in
        // code) or DMs (the handle is the derived dm_<id>_<id> pair key).
        // 409 if taken by another room or reserved as another room's old
        // handle. On success the old handle is recorded in
        // room_slug_aliases (migration 001, wired in v0.9.0) so the old
        // /rooms/{old} permalink keeps resolving.
        if (typeof body.handle === "string") {
          // Turso returns INTEGER columns as the string "0"/"1" — and the
          // string "0" is truthy in JS, so a bare `if (room.is_system)`
          // would block EVERY room (this exact bug shipped in the first
          // 0.9.0 deploy and 403'd a non-system room). Compare explicitly.
          if (room.is_system === 1 || room.is_system === "1") return err("forbidden", "System rooms cannot be renamed", 403);
          if (room.type === "dm") return err("forbidden", "DM rooms cannot be renamed", 403);
          const newHandle = String(body.handle).toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
          if (!newHandle) return err("bad_request", "Invalid handle", 400);
          if (newHandle !== room.handle) {
            const clash = await db.query("SELECT id FROM rooms WHERE handle = ? AND id != ?", [newHandle, room.id]);
            if (clash.length) return err("conflict", "A room with that handle already exists; pick another handle", 409);
            const aliased = await db.query("SELECT room_id FROM room_slug_aliases WHERE slug = ?", [newHandle]);
            if (aliased.length && aliased[0].room_id !== room.id) return err("conflict", "That handle is reserved (it belonged to another room)", 409);
            await db.execute("INSERT OR IGNORE INTO room_slug_aliases (slug, room_id) VALUES (?, ?)", [room.handle, room.id]);
            sets.push("handle = ?"); args.push(newHandle);
          }
        }
        if (!sets.length) return err("bad_request", "Nothing to update", 400);
        args.push(room.id);
        await db.execute(`UPDATE rooms SET ${sets.join(", ")}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, args);
        await audit(db, "agent", agent.id, "room_updated", "rooms", room.id, { fields: sets.map((s) => s.split(" ")[0]) });
        const freshRoom = await roomByHandleOrId(db, room.id);
        return json({ ok: true, room: freshRoom });
      }
      const roomJoin = path.match(/^\/api\/v1\/rooms\/([^/]+)\/(join|leave)$/);
      if (roomJoin && request.method === "POST") {
        const room = await roomByHandleOrId(db, decodeURIComponent(roomJoin[1]));
        if (!room) return err("not_found", "Room not found", 404);
        if (roomJoin[2] === "join") {
          if (await isMember(db, room.id, agent.id)) return json({ ok: true, already_member: true });
          if (room.visibility === "private") {
            const body = await request.json().catch(() => ({}));
            if (!body.invite_hash) return err("forbidden", "Private room: an invite hash is required", 403);
            const inviteHash = await sha256Hex("musemesh-invite:" + body.invite_hash);
            const inv = await db.query("SELECT * FROM room_invites WHERE room_id = ? AND invite_hash = ? AND used_at IS NULL", [room.id, inviteHash]);
            if (!inv.length) return err("forbidden", "Invite is invalid or already used", 403);
            await db.execute("UPDATE room_invites SET used_by = ?, used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", [agent.id, inv[0].id]);
          }
          await db.execute("INSERT OR IGNORE INTO room_members (room_id, agent_id, role) VALUES (?, ?, 'member')", [room.id, agent.id]);
          return json({ ok: true, joined: room.handle }, 201);
        }
        // leave
        if (room.mandatory_membership === 1 || room.mandatory_membership === "1" || room.allow_member_leave === 0 || room.allow_member_leave === "0") {
          return err("forbidden", "This room cannot be left (mandatory membership)", 403);
        }
        await db.execute("DELETE FROM room_members WHERE room_id = ? AND agent_id = ?", [room.id, agent.id]);
        return json({ ok: true, left: room.handle });
      }
      const roomInvite = path.match(/^\/api\/v1\/rooms\/([^/]+)\/invites$/);
      if (roomInvite && request.method === "POST") {
        const room = await roomByHandleOrId(db, decodeURIComponent(roomInvite[1]));
        if (!room) return err("not_found", "Room not found", 404);
        const role = await memberRole(db, room.id, agent.id);
        if (role !== "owner" && role !== "moderator" && !agent.is_platform_owner) return err("forbidden", "Only the room owner, a moderator, or the platform owner can invite", 403);
        const raw = uid("inv_") + uid("");
        const inviteHash = await sha256Hex("musemesh-invite:" + raw);
        const id = uid("rinv_");
        await db.execute("INSERT INTO room_invites (id, room_id, invite_hash, created_by) VALUES (?, ?, ?, ?)", [id, room.id, inviteHash, agent.id]);
        return json({ ok: true, invite_id: id, invite_hash: raw }, 201);
      }
      const roomRemove = path.match(/^\/api\/v1\/rooms\/([^/]+)\/members\/([^/]+)$/);
      if (roomRemove && request.method === "DELETE") {
        const room = await roomByHandleOrId(db, decodeURIComponent(roomRemove[1]));
        if (!room) return err("not_found", "Room not found", 404);
        const role = await memberRole(db, room.id, agent.id);
        if (role !== "owner" && role !== "moderator" && !agent.is_platform_owner) return err("forbidden", "Only the room owner, a moderator, or the platform owner can remove members", 403);
        if (room.mandatory_membership === 1 || room.mandatory_membership === "1") return err("forbidden", "Members cannot be removed from a mandatory room", 403);
        const target = await agentByHandleOrId(db, decodeURIComponent(roomRemove[2]));
        if (!target) return err("not_found", "Agent not found", 404);
        if (target.id === room.owner_id) return err("forbidden", "The room owner cannot be removed", 403);
        await db.execute("DELETE FROM room_members WHERE room_id = ? AND agent_id = ?", [room.id, target.id]);
        return json({ ok: true, removed: target.handle });
      }
      // Room roles — promote/demote a member to moderator (room owner or
      // platform owner only). Moderators can pin, remove members and delete
      // messages; they cannot promote others or touch the room owner.
      const roomRole = path.match(/^\/api\/v1\/rooms\/([^/]+)\/members\/([^/]+)\/role$/);
      if (roomRole && request.method === "POST") {
        const room = await roomByHandleOrId(db, decodeURIComponent(roomRole[1]));
        if (!room) return err("not_found", "Room not found", 404);
        const myRole = await memberRole(db, room.id, agent.id);
        if (myRole !== "owner" && !agent.is_platform_owner) return err("forbidden", "Only the room owner or the platform owner can change roles", 403);
        const target = await agentByHandleOrId(db, decodeURIComponent(roomRole[2]));
        if (!target) return err("not_found", "Agent not found", 404);
        if (!(await isMember(db, room.id, target.id))) return err("bad_request", "Target is not a member of this room", 400);
        const body = await request.json().catch(() => ({}));
        const role = String(body.role || "");
        if (role !== "moderator" && role !== "member") return err("bad_request", "role must be moderator or member", 400);
        if (target.id === room.owner_id) return err("forbidden", "The room owner keeps the owner role", 403);
        await db.execute("UPDATE room_members SET role = ? WHERE room_id = ? AND agent_id = ?", [role, room.id, target.id]);
        await audit(db, "agent", agent.id, role === "moderator" ? "member_promoted" : "member_demoted", "room_members", target.id, { room_id: room.id, role });
        return json({ ok: true, member: target.handle, role });
      }
      // Suspend / unsuspend an agent — platform owner only. A suspended
      // agent cannot authenticate (requireAgent returns 403) until unsuspended.
      const susp = path.match(/^\/api\/v1\/agents\/([^/]+)\/(suspend|unsuspend)$/);
      if (susp && request.method === "POST") {
        if (!agent.is_platform_owner) return err("forbidden", "Only the platform owner can suspend agents", 403);
        const target = await agentByHandleOrId(db, decodeURIComponent(susp[1]));
        if (!target) return err("not_found", "Agent not found", 404);
        if (target.is_platform_owner === 1 || target.is_platform_owner === "1") return err("forbidden", "The platform owner cannot be suspended", 403);
        const suspended = susp[2] === "suspend" ? 1 : 0;
        await db.execute("UPDATE agents SET suspended = ? WHERE id = ?", [String(suspended), target.id]);
        await audit(db, "agent", agent.id, suspended ? "agent_suspended" : "agent_unsuspended", "agents", target.id, { handle: target.handle });
        return json({ ok: true, agent: target.handle, suspended: Boolean(suspended) });
      }
      // Wake an agent — platform owner only. Delivers an agent.wake MCP
      // Event to every active subscription for that agent (a poke; the
      // agent still pulls the real content via sync).
      const wake = path.match(/^\/api\/v1\/agents\/([^/]+)\/wake$/);
      if (wake && request.method === "POST") {
        if (!agent.is_platform_owner) return err("forbidden", "Only the platform owner can wake agents", 403);
        const target = await agentByHandleOrId(db, decodeURIComponent(wake[1]));
        if (!target) return err("not_found", "Agent not found", 404);
        const body = await request.json().catch(() => ({}));
        ctx.waitUntil(deliverWebhookEvent(env, db, "agent.wake", {
          agent_handle: target.handle, reason: String(body.reason || "wake"),
          room_id: body.room_id || "", url: `${baseUrl}/rooms/main-community`,
        }));
        await audit(db, "agent", agent.id, "agent_woken", "agents", target.id, { handle: target.handle });
        return json({ ok: true, woken: target.handle });
      }
      // Delete a message — room owner, room moderator, or platform owner.
      // Soft delete (deleted_at + body cleared) so room_sequence and sync
      // history stay consistent; the FTS row is removed so search never
      // surfaces it; a message.deleted event tells sync consumers.
      const msgDel = path.match(/^\/api\/v1\/messages\/([^/]+)$/);
      if (msgDel && request.method === "DELETE") {
        const msgRows = await db.query("SELECT * FROM messages WHERE id = ?", [msgDel[1]]);
        if (!msgRows.length) return err("not_found", "Message not found", 404);
        const msgRow = msgRows[0];
        const role = await memberRole(db, msgRow.room_id, agent.id);
        if (role !== "owner" && role !== "moderator" && !agent.is_platform_owner) return err("forbidden", "Only the room owner, a moderator, or the platform owner can delete messages", 403);
        if (msgRow.deleted_at) return json({ ok: true, deleted: true, already: true });
        const evtSeq = await nextSequence(db, "events");
        await db.batch([
          { sql: "UPDATE messages SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), body = '' WHERE id = ?", args: [msgDel[1]] },
          { sql: "DELETE FROM search_documents WHERE doc_id = ?", args: [msgDel[1]] },
          { sql: "INSERT INTO message_events (id, sequence, type, room_id, message_id, payload) VALUES (?, ?, 'message.deleted', ?, ?, ?)", args: [uid("evt_"), String(evtSeq), msgRow.room_id, msgDel[1], JSON.stringify({ message_id: msgDel[1], room_id: msgRow.room_id, deleted_by: agent.id })] },
        ]);
        await audit(db, "agent", agent.id, "message_deleted", "messages", msgDel[1], { room_id: msgRow.room_id, sender_id: msgRow.sender_id });
        return json({ ok: true, deleted: true });
      }
      // Single-message permalink fetch (v0.10.0) — GET /api/v1/messages/{id}.
      // Member-only, or the message is in a public room (same read rules
      // as the room message list). 404 if missing or deleted. Includes the
      // permalink, room, sender, attachments (with captions), mentions,
      // hashtags, poll summary, forwarded_from, and seen_count. seen_count
      // lives ONLY here, not on list endpoints (rows-read budget).
      const singleMsg = path.match(/^\/api\/v1\/messages\/([^/]+)$/);
      if (singleMsg && request.method === "GET") {
        const rows = await db.query("SELECT * FROM messages WHERE id = ?", [singleMsg[1]]);
        if (!rows.length || rows[0].deleted_at) return err("not_found", "Message not found", 404);
        const msgRow = rows[0];
        const roomRows = await db.query("SELECT * FROM rooms WHERE id = ?", [msgRow.room_id]);
        const room = roomRows[0];
        if (!room) return err("not_found", "Message not found", 404);
        if (room.visibility === "private" && !(await isMember(db, room.id, agent.id))) return err("forbidden", "Not a member of this room", 403);
        const enriched = (await enrichMessages(db, [msgRow], agent.id, baseUrl))[0];
        const seen = await seenByForMessage(db, room.id, msgRow.id);
        return json({ message: { ...enriched, seen_count: seen.count } });
      }
      // Save / unsave a message (v0.10.0). The agent must be able to read
      // the message to save it (same read rules as the single fetch).
      const saveRoute = path.match(/^\/api\/v1\/messages\/([^/]+)\/(save|unsave)$/);
      if (saveRoute && request.method === "POST") {
        const rows = await db.query("SELECT * FROM messages WHERE id = ?", [saveRoute[1]]);
        if (!rows.length || rows[0].deleted_at) return err("not_found", "Message not found", 404);
        const msgRow = rows[0];
        const roomRows = await db.query("SELECT * FROM rooms WHERE id = ?", [msgRow.room_id]);
        const room = roomRows[0];
        if (!room) return err("not_found", "Message not found", 404);
        if (room.visibility === "private" && !(await isMember(db, room.id, agent.id))) return err("forbidden", "Not a member of this room", 403);
        if (saveRoute[2] === "save") {
          await db.execute("INSERT OR IGNORE INTO saved_messages (agent_id, message_id) VALUES (?, ?)", [agent.id, msgRow.id]);
          return json({ ok: true, saved: true, message_id: msgRow.id }, 201);
        }
        await db.execute("DELETE FROM saved_messages WHERE agent_id = ? AND message_id = ?", [agent.id, msgRow.id]);
        return json({ ok: true, saved: false, message_id: msgRow.id });
      }
      // My saved messages (v0.10.0) — newest first, with room context
      // (enriched payloads). The SPA renders this as a self-chat at the
      // top of the list (job D).
      if (path === "/api/v1/saved" && request.method === "GET") {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || "30"), 1), 100);
        const rows = await db.query(
          `SELECT m.*, s.saved_at AS saved_at FROM saved_messages s
           JOIN messages m ON m.id = s.message_id
           WHERE s.agent_id = ? AND m.deleted_at IS NULL
           ORDER BY s.saved_at DESC LIMIT ?`,
          [agent.id, String(limit)]
        );
        const enriched = await enrichMessages(db, rows, agent.id, baseUrl);
        return json({ saved: enriched });
      }
      // My @mentions (v0.10.0) — newest first, with room + message context.
      // ?unread=true (default) filters to mentions whose message.created
      // event sits past my durable ack cursor; ?unread=false lists all.
      // Only mentions in rooms I can read (member or public) are shown.
      if (path === "/api/v1/mentions" && request.method === "GET") {
        const unreadOnly = url.searchParams.get("unread") !== "false";
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || "30"), 1), 100);
        const conds = ["mm.mentioned_agent_id = ?", "m.deleted_at IS NULL", "(r.visibility = 'public' OR EXISTS (SELECT 1 FROM room_members rm WHERE rm.room_id = r.id AND rm.agent_id = ?))"];
        const args = [agent.id, agent.id];
        if (unreadOnly) {
          conds.push("CAST(e.sequence AS INTEGER) > (SELECT CAST(acknowledged_sequence AS INTEGER) FROM agent_cursors WHERE agent_id = ?)");
          args.push(agent.id);
        }
        const rows = await db.query(
          `SELECT m.*, mm.handle_as_typed, r.handle AS room_handle, r.name AS room_name, r.type AS room_type,
                  a.handle AS sender_handle, a.display_name AS sender_display_name
           FROM message_mentions mm JOIN messages m ON m.id = mm.message_id
           JOIN rooms r ON r.id = m.room_id LEFT JOIN agents a ON a.id = m.sender_id
           LEFT JOIN message_events e ON e.message_id = m.id AND e.type = 'message.created'
           WHERE ${conds.join(" AND ")} ORDER BY m.created_at DESC LIMIT ?`,
          [...args, String(limit)]
        );
        return json({ mentions: rows });
      }
      // Read receipts (v0.10.0) — GET /rooms/{room}/messages/{id}/seen.
      // Member-only. seen_by lists room members whose ack cursor is at or
      // past the message's created-event sequence (see seenByForMessage).
      const seenRoute = path.match(/^\/api\/v1\/rooms\/([^/]+)\/messages\/([^/]+)\/seen$/);
      if (seenRoute && request.method === "GET") {
        const room = await roomByHandleOrId(db, decodeURIComponent(seenRoute[1]));
        if (!room) return err("not_found", "Room not found", 404);
        if (!(await isMember(db, room.id, agent.id))) return err("forbidden", "Not a member of this room", 403);
        const rows = await db.query("SELECT id FROM messages WHERE id = ? AND room_id = ?", [seenRoute[2], room.id]);
        if (!rows.length) return err("not_found", "Message not found in this room", 404);
        const seen = await seenByForMessage(db, room.id, seenRoute[2]);
        return json({ message_id: seenRoute[2], ...seen });
      }
      // Polls (v0.10.0) — vote (room member only; one vote per agent,
      // re-vote updates the choice) and read (same read rules as messages).
      const pollVote = path.match(/^\/api\/v1\/polls\/([^/]+)\/vote$/);
      if (pollVote && request.method === "POST") {
        const polls = await db.query("SELECT * FROM polls WHERE id = ?", [pollVote[1]]);
        if (!polls.length) return err("not_found", "Poll not found", 404);
        const poll = polls[0];
        const msgRows = await db.query("SELECT * FROM messages WHERE id = ?", [poll.message_id]);
        if (!msgRows.length || msgRows[0].deleted_at) return err("not_found", "Poll not found", 404);
        if (!(await isMember(db, msgRows[0].room_id, agent.id))) return err("forbidden", "Not a member of this room", 403);
        if (poll.closes_at && new Date(poll.closes_at) < new Date()) return err("poll_closed", "This poll is closed", 400);
        const voteBody = await request.json().catch(() => ({}));
        const optRows = await db.query("SELECT id FROM poll_options WHERE id = ? AND poll_id = ?", [String(voteBody.option_id || ""), poll.id]);
        if (!optRows.length) return err("bad_request", "option_id is not an option of this poll", 400);
        await db.execute(
          "INSERT INTO poll_votes (poll_id, option_id, agent_id) VALUES (?, ?, ?) ON CONFLICT(poll_id, agent_id) DO UPDATE SET option_id = excluded.option_id, voted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
          [poll.id, voteBody.option_id, agent.id]
        );
        const summary = await pollSummaryForMessage(db, poll.message_id, agent.id);
        return json({ ok: true, poll: summary });
      }
      const pollGet = path.match(/^\/api\/v1\/polls\/([^/]+)$/);
      if (pollGet && request.method === "GET") {
        const polls = await db.query("SELECT * FROM polls WHERE id = ?", [pollGet[1]]);
        if (!polls.length) return err("not_found", "Poll not found", 404);
        const msgRows = await db.query("SELECT * FROM messages WHERE id = ?", [polls[0].message_id]);
        if (!msgRows.length || msgRows[0].deleted_at) return err("not_found", "Poll not found", 404);
        const roomRows = await db.query("SELECT * FROM rooms WHERE id = ?", [msgRows[0].room_id]);
        const room = roomRows[0];
        if (!room) return err("not_found", "Poll not found", 404);
        if (room.visibility === "private" && !(await isMember(db, room.id, agent.id))) return err("forbidden", "Not a member of this room", 403);
        const summary = await pollSummaryForMessage(db, polls[0].message_id, agent.id);
        return json({ poll: summary });
      }
      // Pins — list, pin, unpin. Moderator/owner/platform-owner only to pin.
      const pins = path.match(/^\/api\/v1\/rooms\/([^/]+)\/pins(?:\/([^/]+))?$/);
      if (pins && request.method === "GET") {
        const room = await roomByHandleOrId(db, decodeURIComponent(pins[1]));
        if (!room) return err("not_found", "Room not found", 404);
        if (room.visibility === "private" && !(await isMember(db, room.id, agent.id))) return err("forbidden", "Private room", 403);
        const rows = await db.query("SELECT m.*, p.pinned_by, p.pinned_at FROM room_pins p JOIN messages m ON m.id = p.message_id WHERE p.room_id = ? AND m.deleted_at IS NULL ORDER BY p.sort_order, p.pinned_at", [room.id]);
        return json({ pins: rows });
      }
      if (pins && pins[2] && request.method === "POST") {
        const room = await roomByHandleOrId(db, decodeURIComponent(pins[1]));
        if (!room) return err("not_found", "Room not found", 404);
        const role = await memberRole(db, room.id, agent.id);
        if (role !== "owner" && role !== "moderator" && !agent.is_platform_owner) return err("forbidden", "Only the room owner, a moderator, or the platform owner can pin", 403);
        const msgRows = await db.query("SELECT id FROM messages WHERE id = ? AND room_id = ?", [pins[2], room.id]);
        if (!msgRows.length) return err("not_found", "Message not found in this room", 404);
        const order = await db.query("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM room_pins WHERE room_id = ?", [room.id]);
        await db.execute("INSERT OR IGNORE INTO room_pins (room_id, message_id, pinned_by, sort_order) VALUES (?, ?, ?, ?)", [room.id, pins[2], agent.id, String(Number(order[0].n))]);
        return json({ ok: true, pinned: pins[2] }, 201);
      }
      if (pins && pins[2] && request.method === "DELETE") {
        const room = await roomByHandleOrId(db, decodeURIComponent(pins[1]));
        if (!room) return err("not_found", "Room not found", 404);
        const role = await memberRole(db, room.id, agent.id);
        if (role !== "owner" && role !== "moderator" && !agent.is_platform_owner) return err("forbidden", "Only the room owner, a moderator, or the platform owner can unpin", 403);
        await db.execute("DELETE FROM room_pins WHERE room_id = ? AND message_id = ?", [room.id, pins[2]]);
        return json({ ok: true, unpinned: pins[2] });
      }
      // Reactions — list, add, remove. Membership of the message's room required.
      const react = path.match(/^\/api\/v1\/messages\/([^/]+)\/reactions(?:\/([^/]+))?$/);
      if (react && request.method === "GET") {
        const msgRows = await db.query("SELECT room_id FROM messages WHERE id = ?", [react[1]]);
        if (!msgRows.length) return err("not_found", "Message not found", 404);
        if (!(await isMember(db, msgRows[0].room_id, agent.id))) return err("forbidden", "Not a member of this room", 403);
        const rows = await db.query("SELECT emoji, agent_id, created_at FROM reactions WHERE message_id = ? ORDER BY created_at", [react[1]]);
        return json({ reactions: rows });
      }
      if (react && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const emoji = String(body.emoji || "").trim();
        if (!emoji || emoji.length > 8 || /\s/.test(emoji)) return err("bad_request", "A single emoji (max 8 chars, no spaces) is required", 400);
        const msgRows = await db.query("SELECT room_id FROM messages WHERE id = ?", [react[1]]);
        if (!msgRows.length) return err("not_found", "Message not found", 404);
        if (!(await isMember(db, msgRows[0].room_id, agent.id))) return err("forbidden", "Not a member of this room", 403);
        await db.execute("INSERT OR IGNORE INTO reactions (message_id, agent_id, emoji) VALUES (?, ?, ?)", [react[1], agent.id, emoji]);
        return json({ ok: true, reaction: emoji }, 201);
      }
      if (react && react[2] && request.method === "DELETE") {
        const msgRows = await db.query("SELECT room_id FROM messages WHERE id = ?", [react[1]]);
        if (!msgRows.length) return err("not_found", "Message not found", 404);
        if (!(await isMember(db, msgRows[0].room_id, agent.id))) return err("forbidden", "Not a member of this room", 403);
        await db.execute("DELETE FROM reactions WHERE message_id = ? AND agent_id = ? AND emoji = ?", [react[1], agent.id, decodeURIComponent(react[2])]);
        return json({ ok: true });
      }
      // Files — complete (mark ready) and download (permission-checked signed URL).
      const fileComplete = path.match(/^\/api\/v1\/files\/([^/]+)\/complete$/);
      if (fileComplete && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const rows = await db.query("SELECT * FROM attachments WHERE id = ?", [fileComplete[1]]);
        if (!rows.length) return err("not_found", "File not found", 404);
        if (rows[0].owner_agent_id !== agent.id) return err("forbidden", "Only the uploading agent can complete a file", 403);
        if (rows[0].store === "filekiwi") {
          // Verify against file.kiwi: the upload is only real when every
          // chunk arrived. The Worker never sees the bytes, so this check
          // is the only proof the transfer exists.
          let status;
          try {
            const [folderId, fkFileId] = String(rows[0].object_key || "").split("/");
            status = await filekiwiUploadStatus({ folderId, fileId: fkFileId, uploadAuth: rows[0].upload_auth || "" });
          } catch (e) {
            return err("filekiwi_unavailable", `Could not verify the file.kiwi upload: ${String(e).slice(0, 200)}`, 502);
          }
          if (!status.complete) return json({ ok: false, file_id: fileComplete[1], status: "incomplete", missing: status.missing || [] }, 409);
          await db.execute("UPDATE attachments SET status = 'ready', checksum = ? WHERE id = ?", [body.checksum || rows[0].checksum || "", fileComplete[1]]);
          return json({ ok: true, file_id: fileComplete[1], status: "ready", store: "filekiwi", download_expires_at: rows[0].download_expires_at, expires_at: rows[0].expires_at });
        }
        // Cloudinary delivery needs the provider public_id; the uploader reports it here.
        if (body.provider_key && typeof body.provider_key === "string") {
          await db.execute("UPDATE attachments SET status = 'ready', object_key = ?, checksum = ? WHERE id = ?", [body.provider_key, body.checksum || rows[0].checksum || "", fileComplete[1]]);
        } else {
          await db.execute("UPDATE attachments SET status = 'ready', checksum = ? WHERE id = ?", [body.checksum || rows[0].checksum || "", fileComplete[1]]);
        }
        return json({ ok: true, file_id: fileComplete[1], status: "ready" });
      }
      const fileDownload = path.match(/^\/api\/v1\/files\/([^/]+)\/download$/);
      if (fileDownload && request.method === "GET") {
        const rows = await db.query("SELECT * FROM attachments WHERE id = ?", [fileDownload[1]]);
        if (!rows.length) return err("not_found", "File not found", 404);
        const file = rows[0];
        if (file.room_id) {
          if (!(await isMember(db, file.room_id, agent.id))) return err("forbidden", "Not a member of this file's room", 403);
        } else if (file.owner_agent_id !== agent.id) {
          return err("forbidden", "Only the uploading agent can download an unattached file", 403);
        }
        if (file.status !== "ready" && file.status !== "pending") return err("gone", "File is not available", 410);
        const downloads = Number(file.downloads || 0) + 1;
        await db.execute("UPDATE attachments SET downloads = ? WHERE id = ?", [String(downloads), file.id]);
        if (file.store === "filekiwi") {
          // The Worker never persisted the secretKey, so it cannot rebuild
          // the share link: the full link (with #fragment) lives in the
          // message that carried the file. This endpoint returns the base
          // URL + expiry state and enforces the download window.
          const now = new Date().toISOString();
          if (file.expires_at && now > file.expires_at) return err("gone", "This file.kiwi transfer auto-deleted 90h after upload", 410);
          if (file.download_expires_at && now > file.download_expires_at) return err("gone", "The free download window for this file.kiwi transfer has closed; the file is pending deletion", 410);
          return json({ ok: true, file_id: file.id, store: "filekiwi", share_url_base: file.share_url_base, download_url: null, share_link_in_message: true, download_expires_at: file.download_expires_at, expires_at: file.expires_at, downloads, note: "Open the share link in the file message — it carries the decryption key. This transfer auto-deletes and is never the only copy." });
        }
        let downloadUrl = null;
        if (file.store === "cloudinary") {
          if (!env.CLOUDINARY_CLOUD_NAME) return err("store_not_configured", "Cloudinary is not configured on this deployment", 503);
          // object_key holds the provider public_id after /complete.
          downloadUrl = `https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/image/upload/${file.object_key.split("/").map(encodeURIComponent).join("/")}`;
        } else {
          const isB2 = file.store === "b2";
          const endpoint = isB2 ? env.B2_ENDPOINT : env.TIGRIS_ENDPOINT;
          const accessKey = isB2 ? env.B2_ACCESS_KEY_ID : env.TIGRIS_ACCESS_KEY_ID;
          const secretKey = isB2 ? env.B2_SECRET_ACCESS_KEY : env.TIGRIS_SECRET_ACCESS_KEY;
          const bucket = isB2 ? env.B2_BUCKET : env.TIGRIS_BUCKET;
          if (!endpoint || !accessKey || !secretKey || !bucket) return err("store_not_configured", `Store ${file.store} is not configured on this deployment`, 503);
          downloadUrl = await presignS3({ endpoint, region: s3RegionForEndpoint(endpoint), accessKey, secretKey, bucket, key: file.object_key, method: "GET", expiresSeconds: 900 });
        }
        // Hot-move: a B2 file that crossed the download threshold moves to Tigris.
        if (file.store === "b2" && downloads >= HOT_DOWNLOAD_THRESHOLD && env.TIGRIS_ENDPOINT && env.TIGRIS_ACCESS_KEY_ID) {
          ctx.waitUntil(hotMoveToTigris(env, db, { ...file, downloads }));
        }
        return json({ ok: true, file_id: file.id, store: file.store, download_url: downloadUrl, expires_in_seconds: 900, downloads });
      }
      const fileHotMove = path.match(/^\/api\/v1\/files\/([^/]+)\/hot-move$/);
      if (fileHotMove && request.method === "POST") {
        const rows = await db.query("SELECT * FROM attachments WHERE id = ?", [fileHotMove[1]]);
        if (!rows.length) return err("not_found", "File not found", 404);
        if (rows[0].owner_agent_id !== agent.id && !agent.is_platform_owner) return err("forbidden", "Only the uploading agent or the platform owner can hot-move a file", 403);
        if (rows[0].store !== "b2") return err("bad_request", `File is already on ${rows[0].store}; hot-move only applies to B2 files`, 400);
        const result = await hotMoveToTigris(env, db, rows[0]);
        if (!result.moved) return err("hot_move_failed", `Hot-move did not complete: ${result.reason}`, 502);
        return json({ ok: true, moved: true, from: "b2", to: "tigris" });
      }

      // Forward a message (v0.10.0) — POST /rooms/{room}/messages/{id}/forward.
      // Forwarder must be a member of the SOURCE room (can read it) and of
      // the TARGET room. to_room may be a room handle|id, an agent
      // handle|id (creates/finds the DM via the dedupe rules), or the
      // literal "saved" (saves the message instead of posting). A poll
      // forwards as TEXT quoting the question + a link to the original
      // poll — polls are never duplicated as new polls. The new message
      // carries forwarded_from_* attribution and is re-parsed for
      // mentions/hashtags in the target room.
      const fwd = path.match(/^\/api\/v1\/rooms\/([^/]+)\/messages\/([^/]+)\/forward$/);
      if (fwd && request.method === "POST") {
        const room = await roomByHandleOrId(db, decodeURIComponent(fwd[1]));
        if (!room) return err("not_found", "Room not found", 404);
        const srcRows = await db.query("SELECT * FROM messages WHERE id = ?", [fwd[2]]);
        if (!srcRows.length || srcRows[0].deleted_at) return err("not_found", "Message not found", 404);
        const src = srcRows[0];
        if (src.room_id !== room.id) return err("not_found", "Message not found in this room", 404);
        if (!(await isMember(db, room.id, agent.id))) return err("forbidden", "Not a member of the source room", 403);
        const fwdBody = await request.json().catch(() => ({}));
        const toRef = String(fwdBody.to_room || "");
        if (!toRef) return err("bad_request", "to_room is required", 400);
        if (toRef === "saved") {
          await db.execute("INSERT OR IGNORE INTO saved_messages (agent_id, message_id) VALUES (?, ?)", [agent.id, src.id]);
          return json({ ok: true, saved: true, message_id: src.id }, 201);
        }
        let target = await roomByHandleOrId(db, toRef);
        if (!target) {
          const who = await agentByHandleOrId(db, toRef);
          if (!who) return err("not_found", "Target room or agent not found", 404);
          if (who.id === agent.id) return err("bad_request", "Cannot forward to yourself; use to_room: \"saved\"", 400);
          target = await getOrCreateDm(db, agent, who);
        }
        if (!(await isMember(db, target.id, agent.id))) return err("forbidden", "Not a member of the target room", 403);
        // Forwarding INTO a channel obeys the same broadcast rule as
        // posting: only the channel's owner, moderators, and the
        // platform-owner agent may put content there. Forwarding FROM a
        // channel (reading) is unaffected. Forwarding into a DM is always
        // allowed for members (DMs are not channels).
        if (target.type === "channel" && !(await canPostInRoom(db, target, agent))) {
          return err("channel_read_only", "This channel is broadcast-only: only the room owner, its moderators, and the platform-owner agent can post", 403);
        }
        let fwdType = src.type;
        let fwdText = src.body;
        if (src.type === "poll") {
          const p = await pollSummaryForMessage(db, src.id, agent.id);
          fwdText = `Forwarded poll: ${p ? p.question : src.body}\nOriginal poll: ${permalinkForMessage(src.id, baseUrl)}`;
          fwdType = "text";
        }
        const created = await createMessageInternal(db, env, ctx, {
          room: target, agent, type: fwdType, body: fwdText, baseUrl,
          forwardedFrom: { message_id: src.id, room_id: room.id, agent_id: src.sender_id },
        });
        const fresh = await db.query("SELECT * FROM messages WHERE id = ?", [created.message_id]);
        const enriched = (await enrichMessages(db, fresh, agent.id, baseUrl))[0];
        return json({ ok: true, message: enriched }, 201);
      }
      // Edit a message (v0.10.0) — PATCH /rooms/{room}/messages/{id}.
      // Author ONLY (403 for anyone else, including moderators). The
      // ORIGINAL body is kept in message_edits; the live row gets
      // edited=1 + edited_at; mentions/hashtags are re-parsed; the FTS5
      // row is replaced for public rooms (private rooms/DMs never
      // indexed); a message.edited sync event is emitted. Editing a poll
      // message also updates the poll question (the body IS the question).
      const msgEdit = path.match(/^\/api\/v1\/rooms\/([^/]+)\/messages\/([^/]+)$/);
      if (msgEdit && request.method === "PATCH") {
        const room = await roomByHandleOrId(db, decodeURIComponent(msgEdit[1]));
        if (!room) return err("not_found", "Room not found", 404);
        const rows = await db.query("SELECT * FROM messages WHERE id = ?", [msgEdit[2]]);
        if (!rows.length || rows[0].deleted_at) return err("not_found", "Message not found", 404);
        const msgRow = rows[0];
        if (msgRow.room_id !== room.id) return err("not_found", "Message not found in this room", 404);
        if (msgRow.sender_id !== agent.id) return err("forbidden", "Only the author can edit a message", 403);
        // In a channel, only agents who may post there may edit — a
        // demoted ex-moderator cannot edit their old channel post.
        // (Author-only still applies first, above.)
        if (room.type === "channel" && !(await canPostInRoom(db, room, agent))) {
          return err("channel_read_only", "This channel is broadcast-only: only the room owner, its moderators, and the platform-owner agent can post", 403);
        }
        const editBody = await request.json().catch(() => ({}));
        const newBody = typeof editBody.body === "string" ? editBody.body : null;
        if (newBody === null || !newBody.trim()) return err("bad_request", "body is required", 400);
        if (newBody === msgRow.body) {
          const enriched = (await enrichMessages(db, [msgRow], agent.id, baseUrl))[0];
          return json({ ok: true, message: enriched, unchanged: true });
        }
        const evtSeq = await nextSequence(db, "events");
        const now = new Date().toISOString();
        await db.batch([
          { sql: "INSERT INTO message_edits (id, message_id, old_body, edited_by) VALUES (?, ?, ?, ?)", args: [uid("medit_"), msgRow.id, msgRow.body, agent.id] },
          { sql: "UPDATE messages SET body = ?, edited = 1, edited_at = ? WHERE id = ?", args: [newBody, now, msgRow.id] },
          { sql: "INSERT INTO message_events (id, sequence, type, room_id, message_id, payload) VALUES (?, ?, 'message.edited', ?, ?, ?)", args: [uid("evt_"), String(evtSeq), room.id, msgRow.id, JSON.stringify({ message_id: msgRow.id, room_id: room.id, sender_id: agent.id, edited_at: now })] },
        ]);
        await storeMentions(db, msgRow.id, newBody);
        await storeHashtags(db, msgRow.id, newBody);
        if (room.visibility === "public") {
          await db.execute("DELETE FROM search_documents WHERE doc_id = ?", [msgRow.id]);
          await indexMessageForSearch(db, room, msgRow.id, agent.id, newBody);
        }
        const pollRows = await db.query("SELECT id FROM polls WHERE message_id = ?", [msgRow.id]);
        if (pollRows.length) await db.execute("UPDATE polls SET question = ? WHERE message_id = ?", [newBody, msgRow.id]);
        const fresh = await db.query("SELECT * FROM messages WHERE id = ?", [msgRow.id]);
        const enriched = (await enrichMessages(db, fresh, agent.id, baseUrl))[0];
        return json({ ok: true, message: enriched });
      }

      // Rooms + messages (group/channel/dm share the same message path).
      const msg = path.match(/^\/api\/v1\/rooms\/([^/]+)\/messages$/);
      if (msg && request.method === "POST") {
        const room = await roomByHandleOrId(db, decodeURIComponent(msg[1]));
        if (!room) return err("not_found", "Room not found", 404);
        if (!(await isMember(db, room.id, agent.id))) return err("forbidden", "Not a member of this room", 403);
        // Channels are broadcast-only (v0.10.0 channel enforcement): a
        // group lets every member post, a channel only its owner,
        // moderators, and the platform-owner agent. This gate sits on the
        // shared POST path, so it covers text, trade signals, polls, and
        // file posts alike. Error code channel_read_only (403) so the SPA
        // can tell "read-only for you" apart from "not a member".
        if (room.type === "channel" && !(await canPostInRoom(db, room, agent))) {
          return err("channel_read_only", "This channel is broadcast-only: only the room owner, its moderators, and the platform-owner agent can post", 403);
        }
        const body = await request.json().catch(() => ({}));
        const type = body.type || "text";
        if (type.startsWith("trade_")) {
          // Trade signals are validated, never executed. Execution belongs elsewhere.
          if (!body.trade || !body.trade.symbol) return err("bad_request", "Trade payload requires symbol", 400);
        }
        // Polls (v0.10.0): {type:"poll", poll:{question, options[2..10], closes_at?}}.
        // The stored message body IS the question, so public-room polls are
        // FTS-indexed like any message. A poll message cannot also carry a
        // trade payload or a file attachment.
        let pollSpec = null;
        if (type === "poll") {
          const v = validatePoll(body.poll);
          if (typeof v === "string") return err("bad_request", v, 400);
          pollSpec = v;
          if (body.file_id) return err("bad_request", "A poll message cannot carry a file attachment", 400);
        }
        // Caption override for the attached file (v0.10.0): max 500 chars.
        const postCaption = typeof body.caption === "string" ? body.caption : "";
        if (postCaption.length > 500) return err("bad_request", "caption must be at most 500 characters", 400);
        const idem = body.idempotency_key || null;
        // Optional file attachment: the file must already be uploaded and
        // ready, owned by the sender, and in this room. Validated BEFORE
        // the message is inserted so a bad file_id never creates a message.
        let attachedFile = null;
        if (body.file_id) {
          const frows = await db.query("SELECT * FROM attachments WHERE id = ?", [body.file_id]);
          if (!frows.length) return err("not_found", "Attached file not found", 404);
          attachedFile = frows[0];
          if (attachedFile.owner_agent_id !== agent.id) return err("forbidden", "Only the uploading agent can attach a file to a message", 403);
          if (attachedFile.status !== "ready") return err("bad_request", "Attached file is not ready yet; complete the upload first", 400);
          if (attachedFile.room_id && attachedFile.room_id !== room.id) return err("bad_request", "Attached file belongs to a different room", 400);
        }
        // Idempotent replay: the same sender + idempotency key returns the
        // original message instead of duplicating it.
        if (idem) {
          const existing = await db.query("SELECT id, room_sequence FROM messages WHERE sender_id = ? AND idempotency_key = ?", [agent.id, idem]);
          if (existing.length) return json({ ok: true, message_id: existing[0].id, room_sequence: Number(existing[0].room_sequence), duplicate: true });
        }
        // Shared creation (v0.10.0): atomic sequences, message +
        // message.created event (with mentions), FTS index, mentions/
        // hashtags, poll rows, webhook delivery. File attach + trade
        // payload still happen below, as before.
        const postBody = type === "poll" ? pollSpec.question : (body.body || "");
        const created = await createMessageInternal(db, env, ctx, { room, agent, type, body: postBody, idempotencyKey: idem, poll: pollSpec, baseUrl });
        if (created.duplicate) return json({ ok: true, message_id: created.message_id, room_sequence: created.room_sequence, duplicate: true });
        const msgId = created.message_id;
        const seq = created.room_sequence;
        if (attachedFile) {
          if (postCaption) {
            await db.execute("UPDATE attachments SET message_id = ?, caption = ? WHERE id = ?", [msgId, postCaption, attachedFile.id]);
          } else {
            await db.execute("UPDATE attachments SET message_id = ? WHERE id = ?", [msgId, attachedFile.id]);
          }
          if (attachedFile.store === "filekiwi") {
            // The share link itself is in the message body (posted by the
            // uploader from the init response); the Worker appends the
            // expiry countdown so every reader sees it prominently.
            const notice = filekiwiNotice({ filename: attachedFile.filename, size: Number(attachedFile.size || 0), download_expires_at: attachedFile.download_expires_at, expires_at: attachedFile.expires_at });
            await db.execute("UPDATE messages SET body = ? WHERE id = ?", [(body.body || "") + "\n\n" + notice, msgId]);
          }
        }
        if (type.startsWith("trade_") && body.trade) {
          await db.execute("INSERT INTO trade_payloads (message_id, symbol, exchange, side, timeframe, entry, stop_loss, targets, expires_at, strategy, source_agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [msgId, body.trade.symbol, body.trade.exchange || "", body.trade.side || "", body.trade.timeframe || "", body.trade.entry || "", body.trade.stop_loss || "", JSON.stringify(body.trade.targets || []), body.trade.expires_at || null, body.trade.strategy || "", agent.id]);
        }
        return json({ ok: true, message_id: msgId, room_sequence: seq, ...(attachedFile ? { file: { file_id: attachedFile.id, store: attachedFile.store, ...(attachedFile.store === "filekiwi" ? { download_expires_at: attachedFile.download_expires_at, expires_at: attachedFile.expires_at } : {}) } } : {}) }, 201);
      }
      if (msg && request.method === "GET") {
        const room = await roomByHandleOrId(db, decodeURIComponent(msg[1]));
        if (!room) return err("not_found", "Room not found", 404);
        if (room.visibility === "private" && !(await isMember(db, room.id, agent.id))) return err("forbidden", "Private room", 403);
        const before = url.searchParams.get("before");
        const rows = await db.query(
          before
            ? "SELECT * FROM messages WHERE room_id = ? AND deleted_at IS NULL AND room_sequence < (SELECT room_sequence FROM messages WHERE id = ?) ORDER BY room_sequence DESC LIMIT 30"
            : "SELECT * FROM messages WHERE room_id = ? AND deleted_at IS NULL ORDER BY room_sequence DESC LIMIT 30",
          before ? [room.id, before] : [room.id]
        );
        // Enriched payloads (v0.10.0): permalink, mentions, hashtags,
        // sender, room, attachments (with caption), poll, forwarded_from.
        // seen_count is NOT added here — per-message cursor scans on a
        // list would blow the rows-read budget; it lives on the
        // single-message fetch only.
        const enriched = await enrichMessages(db, rows.reverse(), agent.id, baseUrl);
        return json({ messages: enriched });
      }
      return err("not_found", "Unknown API endpoint", 404);
    }

    // ---- MCP endpoint (Streamable HTTP) ------------------------------------
    if (path === "/mcp" && request.method === "POST") {
      // MCP: initialize + tools/list + tools/call. tools/call dispatches to the
      // REST routes in-process (see the dispatcher above).
      const body = await request.json().catch(() => ({}));
      if (body.method === "initialize") {
        return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {}, events: {} }, serverInfo: { name: "agentx-social", version: "0.14.3" } } });
      }
      if (body.method === "tools/list") {
        return json({ jsonrpc: "2.0", id: body.id, result: { tools: [
          { name: "whoami", description: "Return the calling agent's profile", inputSchema: { type: "object", properties: {} } },
          { name: "sync", description: "Return unacknowledged events across all joined rooms", inputSchema: { type: "object", properties: { cursor: { type: "number" } } } },
          { name: "ack", description: "Acknowledge processed events", inputSchema: { type: "object", properties: { cursor: { type: "number" } }, required: ["cursor"] } },
          { name: "send_message", description: "Send a message to a room", inputSchema: { type: "object", properties: { room: { type: "string" }, body: { type: "string" }, type: { type: "string" } }, required: ["room", "body"] } },
          { name: "search", description: "Permission-safe global search", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
          { name: "request_approval", description: "File a gated action for human approval and stop", inputSchema: { type: "object", properties: { action_type: { type: "string" }, payload_hash: { type: "string" } }, required: ["action_type", "payload_hash"] } },
        ] } });
      }
      // ---- MCP Events (OpenAI Dots wake path, Spike D) ------------------
      // events/list is public (the catalog); subscribe/unsubscribe need
      // the agent's Bearer token. Delivery is webhook-only, Standard
      // Webhooks HMAC, per the design in docs/WAKE_SPIKES.md §D.2.
      if (body.method === "events/list") {
        return json({ jsonrpc: "2.0", id: body.id, result: { events: EVENT_DEFS.map((e) => ({ name: e.name, description: e.description, deliveryModes: ["webhook"], inputSchema: e.inputSchema, payloadSchema: e.payloadSchema })) } });
      }
      if (body.method === "events/subscribe") {
        const { agent, response } = await requireAgent(request, db);
        if (response) return json({ jsonrpc: "2.0", id: body.id, error: { code: -32001, message: "Bearer token required" } });
        const p = body.params || {};
        const def = EVENT_DEFS.find((e) => e.name === p.name);
        if (!def) return json({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: `Unknown event: ${p.name}` } });
        const args = { ...(p.arguments || {}) };
        const delivery = p.delivery || {};
        if (delivery.mode && delivery.mode !== "webhook") return json({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "Only webhook delivery is supported" } });
        if (!isPublicCallbackUrl(delivery.url || "")) return json({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "Callback URL must be public HTTPS (no localhost/private addresses, no redirects)" } });
        const secretRaw = String(delivery.secret || "");
        if (!secretRaw.startsWith("whsec_")) return json({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "A whsec_ signing secret is required" } });
        let secretBytes;
        try { secretBytes = b64Decode(secretRaw.slice("whsec_".length)); } catch { return json({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "Signing secret is not valid base64" } }); }
        if (secretBytes.length < 24 || secretBytes.length > 64) return json({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "Signing secret must decode to 24-64 bytes" } });
        // Authorisation: a room filter only covers rooms the agent can read.
        if (args.room_id) {
          const room = await roomByHandleOrId(db, String(args.room_id));
          if (!room) return json({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "Room not found" } });
          if (room.visibility === "private" && !(await isMember(db, room.id, agent.id))) return json({ jsonrpc: "2.0", id: body.id, error: { code: -32001, message: "Not a member of that room" } });
          args.room_id = room.id;
        }
        if (args.agent_handle) {
          const who = await agentByHandleOrId(db, String(args.agent_handle));
          if (!who) return json({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "Agent not found" } });
        }
        // Deterministic subscription id (idempotent re-subscribe).
        const filtersJson = JSON.stringify(args, Object.keys(args).sort());
        const subId = "sub_" + (await sha256Hex(agent.id + "|" + p.name + "|" + delivery.url + "|" + filtersJson)).slice(0, 32);
        // Lifetime: honour ttlMs, capped at 30 days; default 7 days;
        // ttlMs null = no expiry (refreshBefore null).
        let refreshBefore = null;
        if (p.ttlMs === null) refreshBefore = null;
        else if (p.ttlMs === undefined) refreshBefore = new Date(Date.now() + SUBSCRIPTION_TTL_MS).toISOString();
        else if (Number(p.ttlMs) > 0) refreshBefore = new Date(Date.now() + Math.min(Number(p.ttlMs), 30 * 24 * 60 * 60 * 1000)).toISOString();
        // Callback verification BEFORE any application data is sent.
        const ok = await verifyCallback(delivery.url, secretRaw, subId);
        if (!ok) return json({ jsonrpc: "2.0", id: body.id, error: { code: -32015, message: "Callback verification failed", data: { reason: "challenge_failed" } } });
        const existing = await db.query("SELECT * FROM webhook_subscriptions WHERE id = ?", [subId]);
        if (existing.length) {
          const prev = existing[0];
          const changed = prev.secret !== secretRaw;
          await db.execute("UPDATE webhook_subscriptions SET secret = ?, previous_secret = ?, previous_secret_at = ?, filters_json = ?, refresh_before = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
            [secretRaw, changed ? prev.secret : prev.previous_secret, changed ? new Date().toISOString() : prev.previous_secret_at, filtersJson, refreshBefore, subId]);
        } else {
          await db.execute("INSERT INTO webhook_subscriptions (id, agent_id, event_name, callback_url, secret, filters_json, refresh_before) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [subId, agent.id, p.name, delivery.url, secretRaw, filtersJson, refreshBefore]);
        }
        return json({ jsonrpc: "2.0", id: body.id, result: { id: subId, refreshBefore, cursor: null, truncated: false } });
      }
      if (body.method === "events/unsubscribe") {
        const { agent, response } = await requireAgent(request, db);
        if (response) return json({ jsonrpc: "2.0", id: body.id, error: { code: -32001, message: "Bearer token required" } });
        const p = body.params || {};
        const delivery = p.delivery || {};
        // Idempotent: deleting a non-existent subscription still returns {}.
        if (delivery.url) {
          await db.execute("DELETE FROM webhook_subscriptions WHERE agent_id = ? AND event_name = ? AND callback_url = ?", [agent.id, p.name || "", delivery.url]);
        } else {
          await db.execute("DELETE FROM webhook_subscriptions WHERE agent_id = ? AND event_name = ?", [agent.id, p.name || ""]);
        }
        return json({ jsonrpc: "2.0", id: body.id, result: {} });
      }
      if (body.method === "tools/call") {
        // REAL dispatcher: each MCP tool calls the matching REST route
        // in-process (same Bearer auth, same logic, no HTTP round trip).
        const tool = body.params?.name;
        const args = body.params?.arguments || {};
        const auth = request.headers.get("Authorization") || "";
        const origin = new URL(request.url).origin;
        const callRest = async (method, path, payload) => {
          const res = await handleFetch(new Request(origin + path, {
            method,
            headers: { Authorization: auth, "Content-Type": "application/json" },
            body: payload === undefined ? undefined : JSON.stringify(payload),
          }), env, ctx);
          const text = await res.text();
          let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
          return { status: res.status, data };
        };
        const mcpText = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }], isError: false });
        const mcpError = (message) => ({ content: [{ type: "text", text: message }], isError: true });
        let out;
        if (tool === "whoami") {
          out = await callRest("GET", "/api/v1/agents/me");
          out = out.status === 200 ? mcpText(out.data) : mcpError(out.data?.message || "whoami failed");
        } else if (tool === "sync") {
          out = await callRest("GET", `/api/v1/sync?cursor=${Number(args.cursor || 0)}`);
          out = out.status === 200 ? mcpText(out.data) : mcpError(out.data?.message || "sync failed");
        } else if (tool === "ack") {
          out = await callRest("POST", "/api/v1/sync/ack", { cursor: Number(args.cursor || 0) });
          out = out.status === 200 ? mcpText(out.data) : mcpError(out.data?.message || "ack failed");
        } else if (tool === "send_message") {
          out = await callRest("POST", `/api/v1/rooms/${encodeURIComponent(args.room)}/messages`, { body: args.body, type: args.type || "text", trade: args.trade, idempotency_key: args.idempotency_key });
          out = out.status === 201 ? mcpText(out.data) : mcpError(out.data?.message || "send_message failed");
        } else if (tool === "search") {
          out = await callRest("GET", `/api/v1/search?q=${encodeURIComponent(args.q || "")}`);
          out = out.status === 200 ? mcpText(out.data) : mcpError(out.data?.message || "search failed");
        } else if (tool === "request_approval") {
          out = await callRest("POST", "/api/v1/approvals", { action_type: args.action_type, payload_hash: args.payload_hash, payload: args.payload, scope_key: args.scope_key, room_id: args.room_id, reason: args.reason });
          out = (out.status === 201) ? mcpText(out.data) : mcpError(out.data?.message || "request_approval failed");
        } else {
          out = mcpError(`Unknown tool: ${tool}`);
        }
        return json({ jsonrpc: "2.0", id: body.id, result: out });
      }
      return json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
    }

    // ---- Agent guide (llms.txt, v0.11.1) ----------------------------------
    // One source file (public/llms.txt), two URLs: /llms.txt and /llm.txt.
    // Both must return 200 text/plain with the IDENTICAL body. Placed
    // BEFORE the SPA fallback so the shell never swallows these paths.
    // Static Assets can 307-redirect index-like paths, so a 301-308 is
    // followed only when it still points at /llms.txt itself.
    if ((path === "/llms.txt" || path === "/llm.txt") && request.method === "GET" && env.ASSETS) {
      let res = await env.ASSETS.fetch(new Request(new URL("/llms.txt", request.url), request));
      if (res.status >= 301 && res.status <= 308) {
        const loc = res.headers.get("Location");
        if (loc && new URL(loc, request.url).pathname === "/llms.txt") {
          res = await env.ASSETS.fetch(new Request(new URL(loc, request.url), request));
        }
      }
      if (res.status !== 200) return err("not_found", "Agent guide not found", 404);
      return new Response(res.body, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
    }

    // ---- Static frontend (SPA) --------------------------------------------
    // The real AgentX Social app lives in public/ (Workers Static Assets). The
    // /health, /api/v1/* and /mcp routes are handled above; every other GET
    // is the app shell. The owner dashboard is a view inside the SPA (no
    // composer, read-only for content). API behaviour is unchanged.
    if (request.method === "GET" && env.ASSETS) {
      const assetRes = await env.ASSETS.fetch(request);
      // Static Assets redirects directory-like paths (e.g. /owner → /) and
      // 404s unknown SPA routes; serve the app shell for both, but pass
      // through real asset responses (200/304) untouched. NOTE: fetching
      // /index.html itself 307-redirects to / (index canonicalisation), so
      // the fallback fetches / and rebuilds the response without inheriting
      // the redirect's headers.
      if (assetRes.status !== 404 && !(assetRes.status >= 301 && assetRes.status <= 308)) return assetRes;
      const shell = await env.ASSETS.fetch(new Request(new URL("/", request.url), request));
      return new Response(shell.body, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-AgentX-Frontend": "v0.14.3-spa" } });
    }

    return err("not_found", "Unknown route", 404);
}

export default { fetch: handleFetch };

// ---- Durable Object: hibernating WebSocket fan-out -------------------------
// One object per room/shard. Persist to Turso BEFORE broadcasting; a missed
// push is always recoverable via /api/v1/sync. No timers, no in-memory state
// that must survive hibernation (typing state is best-effort only).
export class RoomSocket {
  constructor(state) { this.state = state; this.sockets = new Set(); }
  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    this.sockets.add(server);
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, message) {
    // Broadcast to other sockets in this room object; delivery is best-effort.
    for (const s of this.sockets) { if (s !== ws) { try { s.send(message); } catch {} } }
  }
  async webSocketClose(ws) { this.sockets.delete(ws); }
  async webSocketError(ws) { this.sockets.delete(ws); }
}
