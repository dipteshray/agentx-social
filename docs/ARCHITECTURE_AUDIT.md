# Spike B — Architecture Audit: Threads.space as the MuseMesh fork base

**Audited:** `https://github.com/danielcorin/threads.space` (MIT)
**Local clone:** `~/workspace/musemesh-build/threads-space-upstream/`
**HEAD at audit time:** `5296c87` — "Merge pull request #66 from filaebot/fix/count-unread-once"
**Audit date:** 2026-11-25
**Method:** static code audit only — read README, `wrangler.jsonc`, `package.json`,
`api/migrations/*.sql`, `api/src/**` (Worker, routes, DOs, MCP, auth, lib), `agent-tools/`
(MCP/CLI action catalog), `client/src/**` (Svelte 5 frontend), `docs/*.md`, `scripts/*`.
No code was executed, built, tested, or deployed; no GitHub repo, Turso DB, or
Cloudflare resource was created (per task instructions). Line numbers below are
from the cloned HEAD and are verifiable with `grep -n` in that directory.
**Repo size at audit:** 487 files (excluding `.git`), 7.8 MB.

**Scope note:** the plan's Spike B also asks for a live stock deploy (two bot users,
a DM proved over WebSocket and over MCP). That part was **not** done here: the task
forbids deploying anything and creating any Cloudflare/GitHub/Turso resource. The
verdict below is therefore a **static-audit verdict**, not a live-deploy verdict.
The live proof still needs doing (by an agent that can deploy) before Phase 1.

---

## 1. Repo snapshot — what the base actually is

| Item | Finding |
|---|---|
| Licence | MIT, Copyright (c) 2026 Daniel Corin (`LICENSE:1-3`) |
| Maturity | Created 2026-08-17, 121 commits, 4 stars, 0 releases (per research report; HEAD `5296c87` matches the report's commit) |
| Stack | One Cloudflare Worker serves Svelte 5 client + Hono HTTP API + WebSockets + MCP (`README.md:7-11`) |
| Frontend | Svelte `^5.57.1`, `@sveltejs/adapter-cloudflare ^8.0.0` (`client/package.json:22,31`); PWA manifest + service worker (`client/static/manifest.webmanifest`, `sw.js`) |
| API framework | Hono (`api/src/index.ts:1`); OpenAPI source of truth in `api/openapi/threads.yaml`, docs at `/api/docs`, `/api/openapi.json` |
| Test suite | 83 test files under `api/src/__tests__/`, 60 of them `*.integration.test.ts` |
| Auth model | Human users: username + password + session cookie, optional TOTP MFA (`api/src/lib/mfa.ts`, `api/src/routes/mfa.ts`), optional email verification (Resend). Bots: Bearer API tokens, no session cookie |
| Admin model | First human is bootstrapped as admin (see §7); `is_admin` gates admin actions only — **not** a read-only owner |
| Extra surfaces | Web Push (VAPID), signed webhooks, link previews, kanban boards, widgets, drafts/scheduled messages, ephemeral (auto) channels, agent "processes" with token accounting, first-party Go bridge + TS CLI in `agent-tools/` |

---

## 2. Per-feature table

Paths are relative to `threads-space-upstream/`. Verdicts: **REUSE** (use as-is),
**REUSE+EXTEND** (present, needs mission-specific changes), **BUILD** (absent, build
from scratch on this base), **REPLACE** (present but the wrong mechanism for the plan).

| Feature (plan §) | Present in code? | Evidence (file:line) | Build-or-reuse verdict |
|---|---|---|---|
| Pins (§8) | **YES, partial** | `api/src/routes/pins.ts:6-39` pin (membership check only, `INSERT INTO pinned_messages …` at :20, 409 on duplicate at :23); `:41-60` unpin; `:62-78` list with join to `pinned_by` username. `api/migrations/0001_initial.sql:350-356` table; `agent-tools/cli/src/actions.ts:770-797` MCP tools `list_pins`/`pin_message`/`unpin_message`; `client/src/lib/components/PinsPanel.svelte` + `client/src/lib/state/pins.svelte.ts` UI. | **REUSE+EXTEND.** Missing vs plan: no role restriction (any member can pin/unpin — no owner/moderator check in `pins.ts`); no `sort_order`; no pin audit events; no pinned-only search filter; no deleted-pin placeholder policy. Schema uses globally-unique `message_id` (`0001:353`) instead of the plan's unique `(room_id, message_id)` — equivalent in practice (a message belongs to one channel) but the constraint differs. |
| Follow (§11) | **NO** | Zero code hits for follow/unfollow/follower in `api/src/` (excluding tests) and `client/src/` — only "follow redirects" in `api/src/routes/link-previews.ts:183` and prose ("follow the link") in the client. No `follows` table in `0001_initial.sql`; no follow route in `api/src/routes/basic.ts` / `non-basic.ts` route inventory; no follow action in `agent-tools/cli/src/actions.ts:165-1226` (full tool list read). | **BUILD.** New tables `follows`, new REST + MCP tools, profile follower/following lists + counts, discovery filters. Following must grant no private access — needs the search/permission work below. |
| Permalinks (§8) | **NO** | No `/message/<id>`, `/g/<slug>`, `/c/<slug>`, `/@<handle>` URL routes anywhere: client has only two routes — `client/src/routes/+page.svelte` and `client/src/routes/login/+page.svelte`. API has `GET /messages/:id` (`api/src/routes/basic.ts:295`, handler `api/src/routes/messages.ts:306-313`, membership-checked) and `GET /channels/:id`, but these are API lookups, not shareable permalinks. Channel identity is `channels.name` UNIQUE (`0001_initial.sql:65`) — no slug column, no `room_slug_aliases` table, no rename-alias behaviour (renames exist only for ephemeral channels, `api/src/routes/channels.ts:280-304`, slug sanitiser `:219`). `api/src/__tests__/message-links.integration.test.ts` is about link previews + @mentions in message bodies, not permalinks. | **BUILD.** Slug generation + collision suffixes, alias table, rename handling, deleted-object "unavailable" behaviour, client routes for `/message/<id>` etc. All permalink checks must still enforce membership (the `requireChannelMembership` helper exists and can be reused). |
| Announcements / cannot-leave rooms (§8) | **NO** | Zero hits for `announce`, `is_system`, `mandatory`, `allow_member_leave` in `api/src/` and `client/src/`. No announcement channel type; `channels` has only `is_private` / `is_dm` / `is_ephemeral` (`0001_initial.sql:63-83`). Leave is unconditional: hard delete `DELETE FROM channel_members …` (`api/src/routes/channels.ts:507-515`); soft leave sets `left_at` (`:517-547`) and only blocks DMs (`:527` "Cannot leave a DM; hide it instead"). Delete is creator-or-admin (`:646-654`) with no system-room exception. | **BUILD.** New `is_system` / `mandatory_membership` / `allow_member_leave` columns, leave/join/remove/delete guards, announcements publish-permission (moderator/platform-owner only), auto-join at registration. **Closest reusable precedent:** the `feedback` channel — auto-joins any authenticated user on first access (`api/src/middleware.ts:10-19`, `api/src/lib/feedback.ts:30-39` `INSERT OR IGNORE … notifications='none'`), is locked against editing (`api/src/routes/channels.ts:418-421`, 403), and is seeded by the baseline migration (`0001_initial.sql:494-501`). It is *not* cannot-leave (both leave paths have no feedback exception) and has no announcements semantics, so it is a pattern to copy, not a feature to reuse. |
| Permission-safe global search (§10) | **PARTIAL — safe but member-only** | Message search exists and is FTS5 with bm25 + 30-day recency decay (`api/src/routes/search.ts:190-198`, `:264-266`), filters `channel`/`from`/`since`/`until`/`has=link,reaction,file` (`:232-258`), phrase/prefix/`OR`/negation query syntax (`:20-118`), empty-query guard (`:147-149`). **But both query branches JOIN `channel_members … AND cm.user_id = ? AND cm.left_at IS NULL`** (`search.ts:171-172` filter-only, `:197-198` FTS) — a searcher sees only rooms they have joined. No unjoined-public-room search, no pinned filter, no attachment filename/text search, OFFSET pagination (`:264-266`) not cursor pagination. Room discovery is separate and weaker: `GET /channels/browse` lists public channel metadata + `is_member` flag (`api/src/routes/channels.ts:73-85`); MCP `find_channels` does substring match on name+description over that list (`agent-tools/cli/src/actions.ts:219-253`). User search is `LIKE`-based, LIMIT 10, no FTS (`api/src/routes/users.ts:684-714`). | **REUSE+EXTEND (large).** The FTS5 index, triggers, and ranking are reusable; the scope model must be extended to include unjoined workspace-public rooms/messages while still excluding private rooms, DMs, and private files — enforced in SQL, per plan §10. Needs: public-visibility branch in `search.ts`, pinned filter, cursor pagination, and a search adapter for the Spike C engine decision. |
| Cursor sync with ack (§9) | **NO — closest analogue is per-channel read markers** | There is **no** `GET /sync` endpoint and no global event stream (full route inventory in §5 below). What exists: (a) `GET /inbox` — a cross-channel *unread projection* (`api/src/routes/basic.ts:292`, `api/src/read-models/inbox.ts:31-91`): message-id cursor (`inbox.ts:33`), unread = `m.id > channel_reads.last_read_message_id` AND NOT in `message_reads` (`:44-49`), only `message_type IN ('human','response')` (`:44`), honours per-channel notification tier (`:50-57`); (b) read markers — `POST /channels/:id/read` and `POST /messages/:id/read` (route list), MCP `mark_read` "Advance the current user's read marker to the latest message" (`agent-tools/cli/src/actions.ts:477-487`); (c) `sync_state` — a **generic per-user key-value store**, keys namespaced `<user.id>:<key>` server-side (`api/src/routes/sync-state.ts:8-10, 36-46`; table `sync_state` at `0001_initial.sql:386-390`), i.e. the client stores its own cursor values, the server never interprets them; (d) per-channel history `GET /channels/:id/messages` with keyset pagination (`api/migrations/0002_channel_timeline_index.sql`). No `message_events` append-only table, no signed/agent-bound cursors, no ack endpoint, no redelivery contract, no event IDs for dedupe. | **BUILD.** New event log + `GET /api/v1/sync` + `POST /api/v1/sync/ack` per plan §9. Reuse the inbox read-model's unread rule and the `channel_reads`/`message_reads` watermark idea as the read-state layer, but the durable cursor/ack contract is new. Note: `mark_read` advancing to *latest* is coarser than ack-after-processing — a crash between fetch and mark loses messages, the exact failure the plan's ack semantics exist to prevent. |
| Trading-signal message types (§13) | **NO** | `messages.message_type` is a closed CHECK enum (`0001_initial.sql:106`): `('human', 'response', 'progress', 'tool_output', 'thinking')`. Creation coerces anything else to `'human'` (`api/src/services/messages.ts:26,171` — `MESSAGE_TYPES` + `isMessageType(...) ? … : 'human'`). No `trade_signal` / `trade_update` / `trade_analysis`, no `trade_payloads` table, no price/symbol validation, no dedupe beyond the generic idempotency key (`0001_initial.sql:124-126` unique `(channel_id, user_id, idempotency_key)`; `services/messages.ts:154-158`). A free-form `metadata` JSON column exists (`0001_initial.sql:113`, inserted at `services/messages.ts:203-204`) so a signal payload *could* be smuggled in unvalidated — but inbox (`read-models/inbox.ts:44`) and conversation lists (`read-models/messages.ts:85`) filter to `human`/`response` only, so a new type would be invisible in the inbox until those filters are extended. | **BUILD.** Extend the enum (migration), add validated `trade_payloads` (decimal-string prices, `expires_at`, dedupe, edit audit trail), extend inbox/conversation filters, add MCP/REST validation. No auto-execution exists anywhere to remove — the "never executes a trade" rule is satisfied by absence. |
| Attachment limits (§12) | **PARTIAL — 25 MB cap matches, everything else differs** | `MAX_UPLOAD_BYTES = 25 * 1024 * 1024` (`api/src/routes/uploads.ts:6`), enforced on `Content-Length` (`:28-30`) and actual bytes (`:48-50`), 413 on overflow. **No type allowlist** — any MIME is accepted; only script-executing types are forced to `application/octet-stream` (`:10-22` `DANGEROUS_MIME_TYPES`, `sanitizeContentType`). **Uploads are proxied through the Worker** — full `arrayBuffer()` in memory then `env.UPLOADS.put` (`:57-62`), no presigned PUT, no direct agent→storage upload. No checksum, no `store` field (`attachments` has only `r2_key, filename, content_type, size_bytes`, `0001_initial.sql:147-155`). Download is a proxied `GET /uploads/:key` with a channel-membership check (`uploads.ts:78-106`), `cache-control: private, max-age=31536000, immutable` (`:100`) — permission-checked but not a short-lived signed URL. Channel delete collects `r2_key`s for cleanup (`api/src/routes/channels.ts:661-665`). | **REPLACE (upload/download flow) + REUSE (cap + permission check).** The 25 MB cap and the "scope access to the attachment's channel" check (`uploads.ts:78-90`) carry over; the R2 `put`/`get`, the proxied-bytes flow, and the schema must be replaced by the §12 storage router (init → presigned PUT → complete → verify size/checksum → metadata with `store`). |
| DMs (§8) | **YES** | Deterministic name `dm-<sorted ids>`, `channels.name` UNIQUE; concurrent creation returns the existing DM (`api/src/routes/dms.ts:61-70` lookup, `:110-116` UNIQUE-fallback re-select); third participant excluded by construction (DM = 2-member channel, `dm_partner_id`); cannot-leave-DM guard (`api/src/routes/channels.ts:527`); hide instead of leave (`PATCH /dms/:id/hide`); bot-DM gating `canUserSendToBotDm` (`api/src/routes/dms.ts:21-38` — bots may DM anyone, admins may DM any bot, otherwise per-bot allow-lists in `bot_capabilities_json`). | **REUSE.** Matches the plan's normalised-pair + concurrent-creation requirement (implemented via the unique channel name rather than a pair constraint — same effect). Per-agent DM-initiation restrictions / block / mute are not present and would be extensions. |
| Auth / scopes (§7, §15) | **YES, close to plan** | Bearer API tokens, scopes `threads:read` / `threads:write` only (`api/src/lib/api-token-policy.ts:2-3`); default both scopes, **default expiry 90 days**, max 3650 days (`:27-45`); raw token returned once, only keyed verifier stored (`api_tokens.token_verifier`, `0001_initial.sql:42-61`); rotation/revocation supported (`api/src/routes/users.ts:141-147, 204-211, 280-355, 471-497`); scope enforced per-method in middleware — GET/HEAD → `threads:read`, everything else → `threads:write` (`api/src/routes/register.ts:35-43`), plus per-handler checks e.g. WS send requires `threads:write` (`api/src/chat-room-actions.ts:74-75`). Sessions are 30-day rows, pruned by the cron (`api/src/index.ts:163-176`). Admin bootstrap: sign in as `admin` with `INSTANCE_SECRET`; conditional insert closes permanently once any human exists (`api/src/routes/auth.ts:75-97`). | **REUSE+EXTEND.** Token model, scopes, and 90-day default match the plan's §2.9 description. Missing: invites (none exist — user creation is admin-gated `POST /users`, `api/src/routes/basic.ts:226`; zero `invite` hits in `api/src/routes/`), agent profiles beyond `display_name`/`avatar_url`/`name_color` (`users` table `0001_initial.sql:3-21` — no bio, handle is `username`, no project/runtime/skills fields; `bot_capabilities_json` is the only extensibility point), single-owner constraint (see §7), and a platform-owner-agent role (no such role; `is_admin` is the only elevated flag). |
| MCP / REST / WebSocket (§3, §15) | **YES** | MCP: stateless Streamable HTTP at `POST /mcp` only, Bearer every request, session cookies rejected (`api/src/mcp.ts:23, 140-180`; transport `WebStandardStreamableHTTPServerTransport`, `sessionIdGenerator: undefined`, `enableJsonResponse: true`, `:174-177`; capabilities `{ tools: {} }` only, `:108`). ~60 tools in `agent-tools/cli/src/actions.ts:165-1226` (whoami, list_conversations, browse/find_channels, create/join/leave_channel, create_dm, list_mentions, mark_read, list/get messages, search_messages, send/reply/edit/delete, upload_attachment, reactions, pins, ephemeral channels, processes, boards, drafts). REST: `/api` under Hono, OpenAPI at `/api/openapi.json`, `/api/docs`, `/api/ws-events.json`, `/api/cli.json`. WebSocket: one global `GET /events` socket for all rooms (`api/src/routes/basic.ts:142-161` → `UserEventsRoom`), per-channel `GET /ws/:channelId` (`:180-204` → `ChatRoom`), presence `GET /ws/presence` (`:163-178` → `PresenceRoom`). Signed webhooks: HMAC-SHA256, `X-Threads-Signature: sha256=…` over `<timestamp>.<payload>` (`api/src/lib/webhooks.ts:98-106, 403-414`), at-least-once delivery with retry table `webhook_deliveries` (`0001_initial.sql:427-443`), drained by the every-minute cron (`api/src/index.ts:163-176`). | **REUSE, with additions.** The transport shape the plan needs is already here. Missing: **MCP Events** — zero hits for `events/list`, `events/subscribe`, or "MCP Events" in `api/src/`, `docs/`, `agent-tools/` (needed for Dots, plan §3.2/§5 Spike D); sync/ack/follow/trade/pin-filter tools (see rows above); `GET /sync` (see sync row). |
| Rooms: groups/channels, long descriptions (§8) | **YES, partial** | Create any public channel as any user; **only admins may create private channels** (`api/src/routes/channels.ts:96-98`, 403 otherwise). `description` is free TEXT with **no length cap enforced** in `handleCreateChannel` (`:88-117`) — long descriptions are storable, but there is no separate "about/rules" field and no byte-cap policy. Member lists, join/leave, member add/remove, notifications tier (`all`/`mentions`/`none`, `0001_initial.sql:85-94`). No owner/moderator roles per room (only channel `created_by` + global `is_admin` gate deletions/edits at `channels.ts:339,364,652,747`). | **REUSE+EXTEND.** Add room roles (owner/moderator), description/rules fields + caps, private-channel creation policy for agents, system-room guards. |
| Loop safety / rate limits (§9) | **PARTIAL** | Per-channel bot-loop circuit breaker: trips after 10 consecutive top-level bot responses in 60 s, auto-resets after 5 min (`api/src/lib/circuit-breaker.ts:5-11`; updated before fan-out in `api/src/services/messages.ts:338`). Login IP rate limit, production only (`api/src/routes/auth.ts:111-116`). **No per-agent or per-room API rate limits** — zero `rate` hits in `api/src/middleware.ts` / `register.ts` / `auth.ts` outside login. No daily budgets, no max automated reply depth, no owner pause switch. | **REUSE+EXTEND.** The circuit breaker is a usable loop-breaker primitive; per-agent/room rate limits, budgets, and the pause switch are **BUILD**. |
| Owner dashboard / audit (§7, §15, §20) | **PARTIAL** | Admin can list users/bots, create/reset/delete users, manage API tokens, read server error logs (`GET /errors`, admin-gated, `api/src/routes/non-basic.ts:176`). Audit-ish: `error_logs` + `metrics` tables (`0001_initial.sql:392-406`), `observability` events (`api/src/lib/observability.ts`). **No owner namespace, no approval queue** (no `approval_requests`/`approval_rules` tables, no such routes), no per-store quota panel, no audit log of admin/agent actions. | **BUILD** (owner namespace + approval queue + quota dashboard). Reuse the admin gating pattern (`api/src/auth.ts:301` `requireAdmin`). |
| Frontend (§4) | **YES, partial** | Svelte 5 SPA: channel/DM lists, message list/composer, threads, reactions, mentions, search panel (`SearchPanel.svelte`), pins panel (`PinsPanel.svelte`), inbox page, presence, settings (incl. Bots tab, ApiTokenManager, Developer tab with Hermes/OpenClaw prompts), PWA. No follow UI, no permalink routes, no owner dashboard, no approval queue UI, no composer-less read-only mode. | **REUSE+EXTEND.** The shell, state stores (`client/src/lib/state/*.svelte.ts`), and WS client (`client/src/lib/ws.svelte.ts`, `useChannelSocket.ts`) are reusable; mission UI is new. |

---

## 3. Durable Object hibernation — the load-bearing question (plan §6)

**Short answer: the DOs are written for hibernation, but hibernation is partial by
design, and one DO can never hibernate while anyone is online.**

### What the code does

All three DOs extend `DurableObject` and use the hibernatable WebSocket API —
`this.ctx.acceptWebSocket(server, tags)` plus `server.serializeAttachment(meta)` —
instead of holding sockets in memory:

```ts
// api/src/chat-room.ts:34-35 (ChatRoom.fetch)
this.ctx.acceptWebSocket(server, [userId, meta.credentialId]);
server.serializeAttachment(meta);
```

```ts
// api/src/user-events-room.ts:38-39 (UserEventsRoom.fetch)
this.ctx.acceptWebSocket(server, [meta.userId, meta.credentialId]);
server.serializeAttachment(meta);
```

```ts
// api/src/presence-room.ts:67-71 (PresenceRoom.fetchImpl)
this.ctx.acceptWebSocket(server, [userId, credential.credentialId]);
server.serializeAttachment({
  missedPings: 0,
  credentialId: credential.credentialId,
  credentialExpiresAt: credential.credentialExpiresAt,
} as WsAttachment);
```

`PresenceRoom` is the most explicit — its comments name hibernation directly:

```ts
// api/src/presence-room.ts:24-30 (constructor)
super(ctx, env);
// Auto-respond to client-initiated app-level keepalive pings WITHOUT waking
// the DO (no webSocketMessage invocation, no hibernation break). Bots send
// {type:"ping"} to detect half-open sockets; the runtime replies {type:"pong"}.
this.ctx.setWebSocketAutoResponse(
  new WebSocketRequestResponsePair(
    JSON.stringify({ type: 'ping' }),
    JSON.stringify({ type: 'pong' }),
  ),
);
```

```ts
// api/src/presence-room.ts:12-15
// Last click/keystroke heartbeat from this client, ms epoch. Absent until the
// first real input — a merely-connected socket is not "active" (see
// getActiveUserIds). Survives hibernation via the socket attachment.
```

```ts
// api/src/presence-room.ts:259 (comment above setGrace)
// Grace timer persistence — survives hibernation via DO storage + alarms
```

### What breaks / limits hibernation

1. **`blockConcurrencyWhile` is never called.** Zero hits in `api/src/` (and
   `client/worker/`). The DOs never block startup on state load; they also never
   explicitly opt into any concurrency control — hibernation here rests entirely
   on the `acceptWebSocket` + attachment pattern, which is the standard
   hibernatable shape, but there is no code that *asserts* or *tests*
   hibernation behaviour.
2. **`PresenceRoom` wakes at least every 30 s while anyone is connected.**
   `HEARTBEAT_INTERVAL_MS = 30_000` (`presence-room.ts:7`); `alarm()` pings every
   connected socket and re-arms itself (`:124-157`, `:284-292`), and
   `scheduleNextAlarm` returns early only when there are no sockets *and* no
   grace timers (`:285-286`). A single global `PresenceRoom` (`idFromName('global')`,
   `api/src/routes/basic.ts:171`, `api/src/lib/credential-connections.ts:33`)
   therefore wakes every 30 s whenever at least one user is online — it can
   hibernate only when the instance is fully idle. This is also a plan §16
   violation in miniature: a single global hot object instead of partitioning.
3. **`ChatRoom` keeps typing state in an in-memory `Map` with `setTimeout`.**
   `chat-room.ts:8` — `private typingUsers = new Map<string, { timer:
   ReturnType<typeof setTimeout>; threadId: string | null }>();` — and the
   8-second auto-expire timer at `:208`. In-memory timers do not survive
   hibernation: a hibernated-then-woken `ChatRoom` loses typing indicators
   (benign — typing state is ephemeral, and `webSocketClose` re-broadcasts).
   No other `ChatRoom` state is in-memory; everything durable goes to D1.
4. **`UserEventsRoom` has no timers and no alarms** — it can hibernate fully
   between `deliver()` RPCs. It is the cleanest of the three.
5. **Fan-out cost is unchanged by hibernation.** Every published message does a
   D1 membership query plus one RPC per member into that member's
   `UserEventsRoom` (`chat-room.ts:96-121` `broadcastGlobalEvents`), and
   `deliver()` iterates that user's sockets (`user-events-room.ts:75-97`).
   Hibernation saves duration (GB-s) while idle; it does not save the per-message
   DO-request count. Budget that in Spike C / `QUOTA_BUDGET.md`.
6. **DO classes are SQLite-backed** (`new_sqlite_classes` in `wrangler.jsonc:34-38`),
   but none of the three uses `ctx.storage` SQL — only `PresenceRoom` uses
   `ctx.storage` (key-value grace timers + alarms, `presence-room.ts:127, 261-291`).
   The D1 database, not DO storage, is the system of record.

**Hibernation verdict: REUSE with eyes open.** The socket-handling shape is
hibernatable and deliberately so; do not rewrite the DOs. But (a) verify
hibernation empirically on a deployed instance (the plan's §6 arithmetic —
100 always-awake objects exhausting 13,000 GB-s/day in ~17 min each — makes
this a measurement, not a code-reading, question); (b) expect `PresenceRoom`'s
30 s heartbeat to keep the single global presence object awake whenever anyone
is online, and consider partitioning presence or lengthening the heartbeat
before 100 agents; (c) treat typing-indicator loss across hibernation as
accepted behaviour.

---

## 4. Storage bindings and what a Turso + B2/Tigris/Cloudinary swap must rewrite

### Bindings as declared (`wrangler.jsonc`)

| Binding | Declaration | Used by |
|---|---|---|
| `DB` (D1) | `wrangler.jsonc:17-19`, `migrations_dir: ./api/migrations` | **457 `env.DB` references** in `api/src/` (excluding tests): every route, read-model, service, lib, and the `/health` migration check (`api/src/index.ts:125-137`) |
| `UPLOADS` (R2) | `wrangler.jsonc:20-22` | 4 `env.UPLOADS` references, all in `api/src/routes/uploads.ts` (`:57` put, `:94` get) |
| `MESSAGE_ANALYTICS` (Analytics Engine) | `wrangler.jsonc:23-25` | 4 references, message metrics only (`api/src/lib/message-analytics.ts`) — optional, droppable |
| `AI` (Workers AI) | `wrangler.jsonc:26` | 3 references, transcription only (`api/src/routes/transcribe.ts:22,52` — Whisper; fails closed 501 when unset) — optional, droppable |
| `CHAT_ROOM` / `PRESENCE_ROOM` / `USER_EVENTS_ROOM` (DOs) | `wrangler.jsonc:27-33`, `new_sqlite_classes` `:34-38` | `api/src/chat-room.ts`, `presence-room.ts`, `user-events-room.ts`; addressed by `idFromName(channelId \| userId \| 'global')` |
| `INSTANCE_SECRET` (+ optional Resend/VAPID) | `package.json` `cloudflare.bindings` + `.dev.vars.example` | Credential encryption, MFA secrets, admin bootstrap |
| Cron `* * * * *` | `wrangler.jsonc:39` | `scheduled()` in `api/src/index.ts:163-176`: scheduled drafts, webhook-drain, session/email/MFA-expiry pruning |

### D1 → Turso rewrite map (not a config change)

1. **Every query call site.** 457 `env.DB.prepare(…).bind(…).all/first/run` sites
   plus **31 `env.DB.batch(…)` sites** (atomic multi-statement, e.g.
   `api/src/routes/channels.ts:102-110` channel+member insert,
   `api/src/lib/mfa.ts:304,377,453,487`, `api/src/lib/webhooks.ts:389,431,449,467`).
   D1 `batch()` is the only transaction mechanism — there is no interactive
   `BEGIN`/`COMMIT`. Each must become a Turso HTTP-client call, and each
   `batch()` must be re-expressed in whatever transaction semantics
   `@tursodatabase/serverless` actually supports (unverified — Spike C).
2. **Migrations.** `api/migrations/0001_initial.sql` (502 lines, ~35 tables) +
   `0002_channel_timeline_index.sql`, applied by
   `wrangler d1 migrations apply DB` — rewrite to Turso dialect/migrations and
   apply outside Wrangler; update `api/src/__tests__/setup.ts`,
   `api/src/service-tests/apply-migrations.ts`, `api/scripts/seed-lib.mjs`,
   `api/scripts/seed-local.mjs`, and the `/health` `d1_migrations` lookup
   (`api/src/index.ts:125-137`).
3. **FTS5.** `messages_fts` virtual table + three sync triggers
   (`0001_initial.sql:129-146`) and all `MATCH`/`bm25()`/`snippet()` SQL in
   `api/src/routes/search.ts:190-212,264` — replace with whichever syntax Spike C
   proves (FTS5 vs Tantivy). This is the highest-risk rewrite; search is the
   only place raw FTS syntax leaks into application code.
4. **DO-side D1 reads.** Membership routing in `chat-room.ts:101-108`
   (`broadcastGlobalEvents`), `user-events-room.ts:107-112`
   (`withRoomMetadata`), `credential-connections.ts:32-38` — the DOs stay, but
   their D1 reads move to Turso with it.
5. **Config.** Remove `d1_databases` from `wrangler.jsonc:17-19` and
   `api/wrangler.toml`; add `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` as Worker
   secrets; keep the DO bindings untouched.

### R2 → B2/Tigris/Cloudinary rewrite map

1. **`api/src/routes/uploads.ts` (whole file, 106 lines).** Replace the proxied
   `env.UPLOADS.put` / `.get` flow with the plan §12 router: init → permission
   check → storage-router pick → presigned PUT (B2/Tigris) or signed upload
   params (Cloudinary) → complete → verify size/checksum → metadata row →
   permission-checked short-lived signed download URLs. Uploads must stop
   passing through the Worker (bytes + CPU + request budget).
2. **`attachments` schema** (`0001_initial.sql:147-155`): `r2_key` → `store`
   (`b2|tigris|cloudinary`) + object key / Cloudinary asset id + checksum +
   status + owner agent. All readers of `attachments` move with it.
3. **Channel-delete cleanup** (`api/src/routes/channels.ts:661-665` collects
   `r2_key`s) and `draft_attachments` handling.
4. **Config.** Remove `r2_buckets` from `wrangler.jsonc:20-22` and
   `api/wrangler.toml`; add B2/Tigris/Cloudinary secrets; buckets + CORS are
   created manually at each provider. **This also removes the card blocker:**
   R2 provisioning is part of `wrangler deploy` / Deploy-to-Cloudflare, so a
   stock deploy cannot complete card-free.
5. **Workers AI + Analytics Engine** can be dropped (transcription and message
   metrics only) or kept; neither touches storage.

### What survives the swap untouched

The three DO classes (except their D1 reads), the Hono route structure, the MCP
action catalog shape, the Svelte client, auth/token machinery, webhooks,
circuit breaker, and the inbox read-model's SQL *shape* (it will need a
dialect pass, but its logic carries over).

---

## 5. Deploy scripts / wrangler config — exact commands from the repo

Nothing here is invented; all commands are quoted from the repo.

**One-click (README.md:13-15):** Deploy to Cloudflare button —
`https://deploy.workers.cloudflare.com/?url=https://github.com/danielcorin/threads.space`.
Cloudflare reads `wrangler.jsonc`, provisions Worker + D1 + R2 + DOs + Analytics
Engine + AI binding, prompts for secrets, runs the root deploy command, applies
the D1 baseline migration.

**Required secret (README.md:17-24, docs/local-deploy.md:14-21):**

```sh
openssl rand -base64 32
```

stored as `INSTANCE_SECRET`. First login is username `admin` with that value;
the bootstrap closes permanently once a human user exists.

**Command-line deploy (docs/local-deploy.md:25-32):**

```sh
npm install
npx wrangler secret put INSTANCE_SECRET
npm run deploy
```

**What `npm run deploy` runs (`package.json` scripts):**

```sh
npm run build && wrangler deploy && npm run db:migrate:remote
```

where `npm run build` = `npm --prefix client run build:worker`,
`npm run db:migrate:remote` = `wrangler d1 migrations apply DB --remote`,
`npm run db:migrate:local` = `wrangler d1 migrations apply DB --local`.

**Local development (README.md:37-54):**

```sh
npm install
cp .dev.vars.example .dev.vars
# Fill INSTANCE_SECRET in .dev.vars
npm run db:migrate:local
npm run build
npx wrangler dev
```

Separate API/client dev: `npm --prefix api run setup:local`,
`npm --prefix api run dev` (http://localhost:8788),
`npm --prefix client run dev` (http://localhost:5173). `setup:local` seeds
`dan` / `dan-password-123` plus the echo-bot fixture.

**Validation (README.md:56-69):**

```sh
npm test
npm run check:threads
npm run build
```

`npm run check:threads` = lint + API tests + `openapi:check` + CLI check +
bridge check + client check + client unit tests (`package.json`).

**Full gate script (`scripts/validate-and-deploy.sh`, also `npm run deploy:local`):**

```sh
scripts/validate-and-deploy.sh [--checks-only] [--allow-dirty]
# runs: npm ci --no-audit --no-fund; npm run check:threads; npm run build;
#       npx wrangler deploy; npm run db:migrate:remote
```

**Verification (docs/local-deploy.md):**

```sh
curl -fsS https://<instance>/health
curl -fsS https://<instance>/api/openapi.json >/dev/null
```

**Updating (docs/local-deploy.md):** pull the desired revision and rerun
`npm install` + `npm run deploy`. The deploy publishes first so Wrangler can
provision resources on a brand-new account, then applies migrations.

**Do-not-use warning:** `api/wrangler.toml` is an API-only local/test harness
("must not be used for production deployment", `docs/local-deploy.md:35-36`);
the root `wrangler.jsonc` is the production source of truth. Note also that
`api/wrangler.toml` ships a local-only default `INSTANCE_SECRET` value — treat
as dev-only and never carry it into a real deployment.

**Optional secrets (docs/local-deploy.md:37-49):** `RESEND_API_KEY`,
`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` via `npx wrangler secret put …`;
`AUTH_EMAIL_FROM`, `VAPID_SUBJECT`, `APP_ORIGIN` as plain `wrangler.jsonc` vars.
Without Resend, email verification/invitations report "not configured"; without
VAPID keys, Web Push is disabled. `INSTANCE_SECRET` must not be rotated after
users/tokens/webhooks/MFA exist (derived verifiers + encrypted MFA secrets break).

---

## 6. Anything else the plan assumes that the code does not have

- **One read-only human owner (§1, §7): absent.** The admin is a normal posting
  user: `is_admin` gates admin actions (`api/src/auth.ts:301` `requireAdmin`;
  `channels.ts:96,339,364,652,747`; `dms.ts:26`; `users.ts` admin gates) and
  **no `is_admin` check exists in `middleware.ts`, `routes/messages.ts`, or
  `services/messages.ts`** — nothing returns 403 for an admin posting. There is
  also no single-owner DB constraint: the bootstrap only closes *first-human*
  creation (`auth.ts:75-97`); further users are created by an admin via
  `POST /users` (`basic.ts:226`). The admin also **cannot read all DMs**:
  `ensureChannelMembership` (`middleware.ts:10-19`) has no admin bypass — only
  the feedback channel auto-joins. Owner-read-all, owner-403-on-post, and the
  single-owner constraint are all **BUILD**.
- **Platform-owner agent (§1, §7): absent.** No such role, no scoped admin API,
  no Worker-secret platform credential. **BUILD.**
- **Invites (§7, §15): absent.** Zero `invite` hits in `api/src/routes/`.
  Registration is admin-created users only. Single-use high-entropy invites,
  atomic registration + mandatory memberships + cursors, token verifiers —
  **BUILD** (token verifier storage itself is reusable: `api_tokens` /
  `sessions` already store `token_verifier`, `0001_initial.sql:42-61`).
- **Agent profiles (§7): minimal.** `users` has `username` (unique), `display_name`,
  `avatar_url`, `name_color`, `bot_capabilities_json` only (`0001_initial.sql:3-21`).
  No bio, project, runtime, skills/tags, model provider/id, timezone,
  capabilities list, or version. **BUILD** (extend table + `PATCH /users/me`).
- **Room roles (§8): absent.** No owner/moderator per room; only channel
  `created_by` + global `is_admin`. **BUILD.**
- **MCP Events for Dots (§3.2, §5 Spike D): absent.** See §2 MCP row. **BUILD.**
- **Approval queue (§20): absent.** No tables, routes, or UI. **BUILD.**
- **Per-agent rate limits / budgets / pause switch (§9): absent.** See §2 loop-safety
  row. **BUILD.**
- **ETags / compact sync payloads (§9): absent.** Zero `etag` hits in `api/src/`.
  **BUILD** (minor).
- **No per-agent databases, no KV for messages/cursors:** satisfied by the base
  already — one D1 database, `sync_state` is KV-shaped but per-user cursor
  *values*, not messages. Keep this invariant through the Turso swap.
- **What the base has that the plan does not need (candidate removals):**
  kanban boards, widgets (+ widget KV), drafts/scheduled messages, ephemeral
  channels, agent "processes" with token accounting, link previews, Web Push,
  feedback channel + feedback bot, email verification. These are inert weight
  unless removed; the processes/kanban/ephemeral surface is large
  (~20 MCP tools, `agent-tools/cli/src/actions.ts:812-1226`) and widens the
  audit surface for a private 100-agent network. Recommend stripping or
  disabling in Phase 1 rather than carrying them.
- **Scale assumptions:** single global `PresenceRoom`; per-message fan-out is
  one D1 query + one RPC per member; search uses OFFSET; no query-plan tests.
  None of these is fatal at 30–40 agents, but all need the Spike C load test
  before 100.

---

## 7. Spike B verdict

### Which mission features must be built from scratch

**Build (absent entirely):** follow + discovery; permalinks/slugs/aliases;
announcements + cannot-leave system rooms; global cursor sync + ack contract;
trading-signal message types + validation; MCP Events; invites; agent profiles
(bio/project/runtime/skills); room roles (owner/moderator); read-only single
human owner + owner namespace; platform-owner agent; approval queue (§20);
per-agent/room rate limits, budgets, pause switch; pinned-only search filter;
attachment store router (B2/Tigris/Cloudinary) replacing R2.

**Reuse + extend (present, needs mission work):** pins (role rules, sort order,
audit, search filter); permission-safe search (extend scope to unjoined public
rooms, cursor pagination); DMs (add initiation restrictions/block/mute); rooms
(long descriptions already storable; add rules/about + caps + roles); auth/token
model (scopes, 90-day expiry, verifiers — matches the plan); MCP/REST/WebSocket
transports; inbox read-state (watermark idea); circuit breaker; feedback-channel
auto-join pattern (copy for mandatory rooms); uploads 25 MB cap + channel-scoped
download check.

**Replace:** D1 → Turso (457 call sites + 31 `batch()` + FTS5 + migrations);
R2 → 3-store router (whole `uploads.ts` + `attachments` schema + delete cleanup);
proxied upload/download → presigned flow.

**Keep as-is:** the three Durable Objects and their hibernatable socket shape
(§3 caveats noted); the Hono route structure; the MCP action-catalog pattern;
the Svelte client shell and WS client; signed webhooks (HMAC-SHA256,
at-least-once + retry table).

### Is the fork still the right base? — Yes, with the rewrite priced in.

The research conclusion stands after reading the code: Threads.space is the
only Workers-native, MIT, MCP/REST/WebSocket + DO codebase found, and the
audit confirms the transport layer the plan needs is genuinely present and
well-tested (83 test files, 60 integration). The missing mission features are
real but they are *features*, not architectural mismatches — none of them
requires undoing the base's structure. The two genuine rewrites (D1→Turso,
R2→3-store router) were already priced into the plan as Phase 1; the audit
confirms their size (457 D1 call sites, 31 `batch()` sites, one FTS5 surface,
one 106-line upload module) and finds no hidden third storage dependency
(Workers AI and Analytics Engine are optional and droppable).

Three conditions before Phase 1:

1. **Do the live Spike B deploy proof** (two bot users, DM over WebSocket and
   over MCP, stock deploy with storage stubbed) — not done in this spike
   because deployment was forbidden by the task. A static audit cannot prove
   the WS fan-out or the MCP tools work end-to-end.
2. **Measure DO hibernation on a live instance** — the code is shaped for it,
   but `PresenceRoom`'s 30 s heartbeat and the single global presence object
   mean the duration budget must be measured, not assumed (§3).
3. **Decide the strip list** — kanban, widgets, ephemeral channels, processes,
   scheduled drafts, link previews, and Web Push are unneeded surface; agree
   whether Phase 1 removes them or carries them.

If any of (1)–(3) fails — e.g. the live deploy shows the DO fan-out or MCP
tools broken, or hibernation does not materialise — re-open the fork decision;
the fallback (D1 instead of Turso, or a narrower rebuild) does not change the
fact that the transport + DO skeleton is the thing being reused.

---

## 8. Spike summary — commands run and exact results

All commands run 2026-11-25 from `~/workspace/musemesh-build/`. No secrets were
written to any file, log, or chat. No GitHub repo, Turso DB, or Cloudflare
resource was created. No deployment was attempted. No `npm`/build/test command
was run inside the clone (static audit only).

| # | Command | Exact result |
|---|---|---|
| 1 | `mkdir -p ~/workspace/musemesh-build/docs && cd ~/workspace/musemesh-build && git clone https://github.com/danielcorin/threads.space threads-space-upstream` | `Cloning into 'threads-space-upstream'...`, exit 0. (A runtime execution-risk notice was raised on this exec result; no further git/package-manager commands were run inside the clone afterwards — all subsequent inspection was read-only text search and file reads.) |
| 2 | `cd threads-space-upstream && git log --oneline -3 && git rev-parse HEAD && git remote -v` (same exec as the clone) | HEAD `5296c87c8243c48021d613f00b7d15174c154f47`; top commits `5296c87 Merge pull request #66 from filaebot/fix/count-unread-once`, `e4cb854 fix(api): avoid repeat unread counts and index channel timelines`, `cbabfd8 Detect the iOS keyboard against 100dvh, not only innerHeight`; remote `origin https://github.com/danielcorin/threads.space` (fetch + push). Matches the research report's commit `5296c87`. |
| 3 | `find . -type f -not -path './.git/*' \| sort` (+ `wc -l`, `du -sh`) | **487 files**, **7.8 MB**. Top-level: `README.md`, `wrangler.jsonc`, `package.json`, `LICENSE` (MIT), `api/` (Worker + `migrations/0001_initial.sql`, `0002_channel_timeline_index.sql`), `client/` (Svelte 5), `agent-tools/` (CLI + Go bridge + contracts), `docs/`, `scripts/`, `security/`, `examples/`. |
| 4 | `grep -rn -i "hibernat\|blockConcurrencyWhile\|…" api/src/ client/worker/` | `blockConcurrencyWhile`: **0 hits**. `hibernat*`: only comments in `presence-room.ts:15,28,66,259`. `acceptWebSocket`: `chat-room.ts:34`, `presence-room.ts:67`, `user-events-room.ts:38`. `serializeAttachment`/`deserializeAttachment`: all three DO files (see §3). |
| 5 | `grep -rni "follow" api/src/ client/src/` | No follow feature: only `link-previews.ts:183` ("Follow redirects…") and prose in client files. |
| 6 | `grep -rni "trade\|signal"` (message-type sense) | No trading types: only "signal" in `signal: controller.signal` (AbortSignal), "signals the agent" (process cancel), etc. |
| 7 | `grep -rni "announce\|cannot.leave\|allow_member_leave\|is_system\|mandatory" api/src/` | **0 hits** (only `channels.ts:527` "Cannot leave a DM"). |
| 8 | `grep -rni "events/list\|events/subscribe\|MCP Events" api/src/ docs/ agent-tools/` | **0 hits** — no MCP Events. |
| 9 | `grep -rni "invite" api/src/routes/` | **0 hits** — no invite system. |
| 10 | `grep -rn -i "etag" api/src/` | **0 hits** — no ETags. |
| 11 | `grep -rn "env\.DB" / "env\.UPLOADS" / "env\.AI" / "MESSAGE_ANALYTICS" api/src/` (excl. tests) | `env.DB`: **457**; `env.UPLOADS`: **4** (all `uploads.ts`); `env.AI`: **3** (all `transcribe.ts`); `MESSAGE_ANALYTICS`: **4**. `\.batch(`: **31** sites. |
| 12 | `grep -o -E "\.(get\|post\|patch\|delete\|put)\('[^']+'" api/src/routes/basic.ts api/src/routes/non-basic.ts \| sort -u` | Full route inventory captured (§5 + §2): no `/sync`, no follow/trade/approval routes; pins at `POST/GET /channels/:id/pins`, `DELETE /channels/:id/pins/:messageId`; `GET /inbox`, `POST /channels/:id/read`, `POST /messages/:id/read`; `GET /events`, `GET /ws/:channelId`, `GET /ws/presence`; `GET /search`, `GET /users/search`, `GET /channels/browse`. |
| 13 | `grep -n "name: '" agent-tools/cli/src/actions.ts` | ~60 MCP tools listed (`whoami` … `delete_saved_draft`); pins, search, mark_read, upload present; **no sync/ack/follow/trade tools**. |
| 14 | File reads (whole files) | `README.md`, `wrangler.jsonc`, `package.json`, `api/migrations/0001_initial.sql` (502 lines) + `0002`, `api/src/index.ts`, `chat-room.ts` (231 lines), `presence-room.ts` (293), `user-events-room.ts` (117), `mcp.ts` (180), `routes/search.ts` (281), `routes/pins.ts` (79), `routes/uploads.ts` (106), `routes/sync-state.ts` (41), `read-models/inbox.ts`, `routes/channels.ts` (leave/create/delete excerpts), `routes/dms.ts`, `routes/messages.ts` + `services/messages.ts` (type/idempotency excerpts), `lib/api-token-policy.ts`, `lib/circuit-breaker.ts`, `lib/webhooks.ts` (HMAC excerpts), `lib/feedback.ts`, `middleware.ts`, `docs/local-deploy.md`, `scripts/validate-and-deploy.sh`, `api/wrangler.toml`, `.dev.vars.example`. |

**Open items carried out of Spike B (not blockers for the audit verdict):**
- Live stock-deploy proof (two bots, DM over WS + MCP) — needs an agent that
  can deploy; R2 provisioning needs a card, so attachments must be stubbed or
  the deploy done with the R2 binding removed for the spike, per plan §5.
- Empirical DO hibernation / GB-s measurement on a live instance.
- Turso engine decision (FTS5 vs Tantivy) — Spike C, blocks the search rewrite.
