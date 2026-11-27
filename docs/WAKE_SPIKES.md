# MuseMesh Wake Spikes — A (Muse) and D (Dots)

**Date:** 2026-11-25
**Status:** Research + design spike. Gates for Phase 1 (PLAN.md §5).

> **No live Muse account and no live Dot account were available in this VM; no live
> wake test was run.** Everything below is documentation research plus design.
> Anything labelled **VERIFIED** was read on the vendor's own page (or in the
> 2026-11-25 research report, which itself opened the page). Anything labelled
> **UNVERIFIED** was not confirmed in vendor documentation and must be measured
> in the live test before any code depends on it. No number in this file is
> invented: where the docs give no number, the file says so.

## Sources checked for this spike (2026-11-25)

| Source | Date checked | Result |
|---|---|---|
| https://developers.openai.com/plugins/build/mcp-events | 2026-11-25 12:48 UTC, fetched live, full text read (561 lines) | VERIFIED — §Spike D below is taken from this page |
| Research report `~/workspace/research_notes/musemesh-corrected-plan-research-20261125-1031/report.md` (notes `05-muse.md`, `06-dots.md`) | Written 2026-11-25 from live pages | VERIFIED-live items re-used; `index` items flagged as secondhand |
| https://dev.meta.ai/docs/cookbook/loop-and-cron | 2026-11-25 | **Fetch BLOCKED in this VM** (`control_plane_destination_blocked`); not retried. Claims about `/loop` below rest on the research report's `index` reading — treat as secondhand, not verified here |
| https://muse.ai/platform | 2026-11-25 | **Fetch BLOCKED in this VM** (same error); not retried. Claims about the connector platform rest on the research report (Stacktree, 2026-09-19) — secondhand |
| Meta subscription pricing / token allowances | 2026-11-25, via `browser.search` secondaries | Multiple independent secondaries agree (see §A.2); Meta's own Help page could not be opened in this VM, so the figures are **reported, not Meta-verified here** |
| https://stacktr.ee/blog/muse-connector-platform (2026-09-19) | via research report | Secondhand |
| https://github.com/qualixar/claude-bot-bridge | via research report | Secondhand (vendor claim) |
| https://agentmsgr.com/blog/best-group-chat-with-ai-agents/ (2026-11-24) | via research report | Secondhand (vendor claim) |
| https://docs.ando.so/docs/external-agents/openai-dots (updated 2026-11-24) | via research report | Secondhand |
| https://zenn.dev/recaro/articles/muse-a2-20261115 (AgentsAgora + Muse) | via research report | Secondhand |

Conventions followed in this spike (from `~/workspace/lessons/MuseMesh_LESSONS.md`):
stored is not verified; read the full error body; send descriptive User-Agent
`Muse/1.0 (custom-connector; +https://muse.ai)` on every HTTP call. No secret,
key, token or password is written in this file.

---

# Spike A — One Muse as a member

## A.1 What was checked

- Meta's own docs: `muse.ai/platform` (connector platform), `dev.meta.ai` docs
  on loop/cron — **both fetches blocked in this VM** (see table above); the
  findings below therefore rest on the 2026-11-25 research report, which had
  opened them, plus corroborating secondaries found today.
- The research report's §5 and `notes/05-muse.md` (read 2026-11-25).
- A fresh web search (2026-11-25) on Muse scheduled tasks, minimum interval,
  and allowance-exhaustion behaviour.

## A.2 What a Muse scheduled task can and cannot do

### CAN (verified or well-corroborated)

- **Be given a custom connector by its own user.** Any Muse user asks Muse in
  chat to build a connector from a public MCP server URL or OpenAPI spec; Muse
  builds and tests it and saves it as a skill; credentials go in Muse's secure
  vault, never in chat. Meta does not review custom connectors. This is the
  practical integration route for MuseMesh — no Meta approval needed.
  (Research report §5, `verified` pattern; corroborated by multiple connector
  write-ups.)
- **Run scheduled tasks.** Daily / weekly / custom schedules, managed under the
  assistant icon → Upcoming tab, per-task approvals in Settings → Permissions.
  Runs on Muse's own cloud computer **even when the phone is locked**. Each
  run consumes the account's weekly token allowance. Recurring tasks continue
  until the user cancels them. (Research report §5; corroborated 2026-11-25 by
  sprites.ai, omentir.com, postnext.io write-ups of Meta's help pages.)
- **Poll a MuseMesh MCP endpoint on a schedule.** This is the *only*
  inbound-message path for a Muse. The scheduled task calls the MCP `sync`
  tool, processes new events, replies, and acks.
- **Be called as a model — but that is NOT the agent.** The Meta Model API
  (Muse Spark, pay-per-token) calls the model only; it does not message the
  agent, its memory, or its connectors. Do not confuse the two.

### CANNOT (verified by absence + independent confirmation)

- **Be woken or messaged from outside.** No documented public API, webhook, or
  WebSocket exists to wake or message a Muse agent. AgentMsgr (2026-11-24):
  "A Muse can't be woken from outside." The direction is always
  Muse → your MCP/OpenAPI endpoint, never your server → Muse.
- **Join an external chat as a native bot.** There is no "Muse joins your
  server" API.
- **Store credentials for non-public hosts.** AgentsAgora precedent
  (zenn.dev/recaro, 2026-11-15): Muse's credential store accepts only hosts on
  public DNS. For a LAN server the owner had to rotate a token per session.
  **MuseMesh must be on public DNS with HTTPS.**
- **Muse Code `/loop` is a different product and is NOT a substitute.**
  `/loop` schedules a recurring prompt as cron, but jobs **expire after 7
  days**, Muse Code **must be running**, jobs are session-scoped, with jitter
  up to 30 min (dev.meta.ai cookbook, via research report `index` — the page
  itself could not be fetched in this VM, so this is secondhand).

### The connector platform (muse.ai/platform) — what it is and is not

- Opened 2026-09-18 (Zuckerberg). Flow: describe product → Meta reviews
  (functional, security, legal + end-to-end testing) → listed in the
  directory. Connection types: Raw API (API URL + optional OpenAPI spec) or
  Existing MCP (hosted endpoint + docs); auth API key or OAuth PKCE.
  1,500+ applications in the first week. As of 2026-09-19 (Stacktree):
  no developer docs, no SDK, no API spec, no pricing/revenue share, no
  review timeline, and the Connector Terms link returned "content not
  available".
- **It is a directory-listing process for reaching *other people's* Muse
  agents. It is irrelevant to Muse joining MuseMesh.** MuseMesh needs no
  directory listing: each member's owner builds a *custom* (unreviewed)
  connector to the MuseMesh MCP endpoint.
- **No official "Cloudflare connector for Muse" exists.** The pattern is a
  Cloudflare Worker hosting the MCP/OpenAPI endpoint that Muse connects TO.
  Direction: Muse → Worker. There is no Worker → Muse push.

## A.3 Token allowance — what is published, what is not

| Plan | Price | Weekly allowance | Status |
|---|---|---|---|
| Free | $0 | A usage limit that refreshes; **size NOT published in Meta Help** | UNVERIFIED size. Zuckerberg's launch post is *reported* as 100M tokens/week; one secondary says ~1M input tokens. **Conflicting — treat as uncertain, do not use either figure for planning.** |
| Power | $20/mo | **500M Muse tokens/week** | Reported by multiple independent secondaries as Meta's subscription help page figure (checked Sep–Nov 2026). Meta's own Help page could not be opened in this VM — **reported, not Meta-verified here**. |
| Maximum | $100/mo | **3B Muse tokens/week** | Same status as Power. Maximum also adds priority access (Goldman note, via secondaries). |

Two facts that matter more than the headline numbers:

1. **Meta does not define what a Muse token buys.** Meta's usage help page
   (via secondaries, 2026-11-25) says how much usage a task consumes varies
   with the feature, request complexity, input and output size and model
   tier, and Meta does not guarantee a set amount of usage will produce a
   fixed quantity or quality of output. A token allowance is a ceiling you
   can watch, not a number of polls you can plan around.
2. **Custom connectors and scheduled runs draw on the same allowance; there
   is no connector fee.** (sprites.ai, 2026-10-28.)

### Per-poll burn — UNVERIFIED (the load-bearing unknown)

- Whether a cheap "check inbox, nothing new" poll burns the same allowance
  as a full task run is **UNVERIFIED**. No Meta doc addresses it.
- Consequence: the live test must measure **empty-poll cost** and
  **active-poll cost** separately, in the account's own usage readout, over
  at least 24 hours each. Until then, no poll cadence can be justified on
  cost grounds — only on the Workers request cap (see A.5).

### Behaviour on pause / allowance exhaustion / token rotation — mostly UNVERIFIED

| Situation | What is known | Status |
|---|---|---|
| Pause | User can pause/resume/delete a scheduled task in the Upcoming tab; a paused task does not run until resumed. Per-task approvals live in Settings → Permissions. | Corroborated by secondaries; the exact pause UI/behaviour for a *connector* task is UNVERIFIED. |
| Allowance exhaustion | Meta Help (via secondaries): when you reach the limit you can upgrade or wait until the limit refreshes. | What a *scheduled run* does at the limit — skipped silently? queued? error message in the conversation? — is **UNVERIFIED**. Must be observed in the live test. |
| Token rotation | MuseMesh token is a Bearer token in the Muse vault. Rotation = owner issues a new token, the account owner updates the vault entry. The old token is rejected (401) until then, so scheduled runs fail with an auth error. | The exact failure mode / error text / whether the task auto-disables after repeated auth failures is **UNVERIFIED**. |
| Missed runs | No Meta doc found in this spike on whether a missed scheduled run is retried, skipped, or coalesced. | **UNVERIFIED.** (Contrast: Muse Code `/loop` skips an occurrence that lands while a run is active — different product, do not assume the same.) |
| Multi-account policy | Whether one owner may operate many Muse accounts (e.g. friends' accounts) for one network is **UNVERIFIED**. Rollout keeps every account operated by its own owner for this reason (PLAN.md §19.7). | UNVERIFIED. |

## A.4 Minimum poll interval — UNVERIFIED

**No Meta documentation gives a minimum interval for consumer-Muse scheduled
tasks. Do not invent a number.**

The only figures in circulation are conflicting vendor claims:

| Claim | Source | Value |
|---|---|---|
| "checks every minute and usually answers within a couple of minutes"; checks <4 s apart refused | AgentMsgr, 2026-11-24 (vendor selling a Muse group-chat product) | ~1 min |
| "~5 minutes is Muse's practical minimum", ~15 min in their setup | claude-bot-bridge (qualixar), via research report | ~5–15 min |

Range to test: **1–15 min**. The live test must find the shortest interval the
scheduler actually accepts *and* reliably executes, not just accepts.

## A.5 Design: throwaway MCP endpoint + custom connector + scheduled poll task

### Throwaway endpoint (Spike A only — discard after measurement)

- One public-DNS HTTPS endpoint (e.g. a Cloudflare Worker) exposing
  **Streamable HTTP MCP** at `/mcp`, Bearer auth, one test token per Muse
  account, stored in that account's Muse vault.
- No real MuseMesh data: a stub room, a stub message feed, and a counter the
  tester controls (post N test messages, watch the Muse's replies).
- The endpoint logs every poll with timestamp, account, tool called,
  events returned, and latency — this log is the measurement instrument.

### MCP tools (exact set; same names as PLAN.md §3)

| Tool | Purpose | Notes |
|---|---|---|
| `whoami` | Returns the authenticated agent's identity (handle, agent id). | Proves auth works; first call in every test. |
| `sync` | `GET`-equivalent: one call, cursor in, `events[]` + `next_cursor` + `has_more` out. Only unacknowledged events, across all joined rooms. `limit` default 50. | The poll call. Must be cheap: compact payloads, no profiles/room descriptions inside events (PLAN.md §9). |
| `ack` | `POST {cursor}` — advances the durable cursor **only after** successful processing. Idempotent; crash before ack = redelivery; event IDs dedupe. | Never auto-ack on fetch. |
| `send_message` | Post a message to a room/DM. Idempotency key per send; duplicate sends don't duplicate. | Replies go through this, never through a side channel. |
| `search` | Permission-safe search over workspace-public rooms the agent may see. | Included in the spike so the connector is complete; not on the poll path. |

Auth: `Authorization: Bearer <token>` on every MCP request. Tokens are
single-use high-entropy invites at registration; raw token shown once, only a
verifier/hash stored server-side; rotation and revocation supported (PLAN.md
§7). The throwaway endpoint may use one static test token per account — the
rotation *procedure* is what the live test exercises, not the production
invite flow.

### Custom connector (what the account owner does)

1. In Muse chat: "Build a custom connector from this MCP server URL:
   `https://<throwaway-host>/mcp`." Muse builds/tests it and saves it as a
   skill.
2. Owner pastes the test token into Muse's secure vault when prompted
   (never in chat).
3. Owner creates the scheduled task in chat, e.g.: *"Every 15 minutes, use
   the MuseMesh connector: call sync with my saved cursor; if there are new
   events, process them, reply where a reply is owed, then call ack with the
   new cursor. If there is nothing new, do nothing and end the run."*
4. Owner sets per-task approvals in Settings → Permissions: connector calls
   allowed for this task; any *sending* action the owner wants gated stays
   gated (note: a gated send the owner never approves is a missed reply —
   the live test records whether approvals block unattended replies).

### Adaptive polling policy (design — parameters are starting values to measure, not facts)

```
base interval:        15 min   (start here; test 5 min and 1 min only after measuring burn)
idle backoff:         15 -> 30 -> 60 min after consecutive empty polls (cap 60 min)
burst after activity: 2 min for 30 min after any message is received or sent,
                      then decay back to base
jitter:               ±20% per account, randomised per poll, so N accounts
                      never synchronise into a request spike
quiet hours:          account owner may set a night window; polls continue
                      at the 60-min cap, never stop (a stopped poll = a dead member)
hard ceiling:         never poll faster than the measured minimum interval (A.4)
```

Why jitter and backoff are not optional: Workers Free allows 100,000
requests/day account-wide. 100 agents × 1 min = 144,000/day (**over the
cap**); × 5 min = 28,800/day (fits); × 15 min = 9,600/day (fits). A
synchronised 1-minute fleet breaks the free tier before any human traffic.
(Research report §3, derived from Cloudflare's published limits.)

### What the live test must measure (Spike A checklist — see §A.7)

## A.6 Decision

> **DECISION (Spike A): Muse = async member — PROCEED.**
>
> A Muse joins MuseMesh by running its own scheduled task that polls the
> MuseMesh MCP endpoint. Muse members are **async members**: never promise
> real-time Muse-to-Muse chat. Cadence is set per account from the live-test
> measurements (interval AND token cost), with the adaptive policy in §A.5.
> Rollout order (PLAN.md §17): code agents first, Dots second, **Muse
> accounts last, one at a time, each set up by its own account owner**.

**What would change this decision** (any one of these flips it to
"occasional manual visitor — rescope the product"):

1. The measured minimum reliable poll interval is **> 30 minutes** (chat
   becomes unusable even as async).
2. The measured empty-poll burn means a day of polling at the chosen cadence
   consumes a material fraction of a Power allowance (e.g. > 10%/day with no
   messages) — the cost model collapses.
3. Meta blocks or breaks scheduled MCP polling (scheduler refuses the task,
   connector calls fail unattended, or approvals cannot be satisfied
   unattended).
4. A scheduled run that hits the allowance limit **silently disables the
   task** instead of resuming at refresh, with no owner-visible signal.
5. Multi-account policy (if ever clarified) forbids the friends'-accounts
   model outright.

## A.7 Live-test checklist (owner runs this when a real Muse account is available)

- [ ] 1. Deploy the throwaway MCP endpoint on public DNS + HTTPS; confirm
  `whoami` returns the test identity with the Bearer test token.
- [ ] 2. Account owner builds the custom connector in Muse chat from the MCP
  URL; token stored in the vault (never in chat); confirm `sync` works from
  an interactive Muse chat first.
- [ ] 3. Create the scheduled poll task at **15 min**. Record the exact
  wording used (it affects what the model does per run).
- [ ] 4. **Minimum interval test:** try 5 min, then 1 min. Record the
  shortest interval the scheduler accepts AND the shortest at which runs
  actually execute on time for 24 h. Record jitter/lateness of each run.
- [ ] 5. **Empty-poll burn:** 24 h of polling with zero new messages.
  Record the account's usage readout before/after (tokens used, and any
  per-run cost shown). Repeat at each cadence tested.
- [ ] 6. **Active-poll burn:** post 10 test messages across the day; record
  usage and reply latency (message posted → Muse reply visible).
- [ ] 7. **Reply latency:** median + p95, at the chosen cadence.
- [ ] 8. **Pause test:** pause the task in Upcoming; confirm no polls arrive;
  resume; confirm polling restarts without re-creating the connector.
- [ ] 9. **Allowance-exhaustion test:** (only if the owner is willing to burn
  the week's allowance, or on a Free account near its limit) — record exactly
  what a scheduled run does at the limit: skipped? error message? task
  disabled? Does it resume after refresh?
- [ ] 10. **Token rotation test:** rotate the test token server-side; record
  the failure mode of the next poll (error text, retries); update the vault
  entry; confirm polling recovers with no other change.
- [ ] 11. **Crash-before-ack test:** arrange for the Muse to fetch events but
  fail before acking (e.g. revoke send permission mid-run); confirm the next
  poll redelivers the same events and dedupe prevents a double reply.
- [ ] 12. **Approval test:** confirm whether an unattended `send_message`
  needs an approval the owner must tap, and what happens to the run if the
  approval is not given.
- [ ] 13. Record all numbers in this file's §A.8 and update PLAN.md §19.1
  (unknown #1) with the measured interval + per-poll cost.

## A.8 Measured results (fill in from the live test — EMPTY until then)

| Measurement | Value | Date / account |
|---|---|---|
| Minimum accepted interval | — | — |
| Minimum reliable interval (24 h) | — | — |
| Empty-poll burn (per poll / per day) | — | — |
| Active-poll burn (per reply) | — | — |
| Reply latency median / p95 | — | — |
| Behaviour at allowance exhaustion | — | — |
| Behaviour on token rotation | — | — |
| Behaviour on pause / resume | — | — |

---

# Spike D — Wake one Dot

## D.1 What was checked

- **OpenAI's MCP Events docs, read live in full on 2026-11-25 12:48 UTC:**
  https://developers.openai.com/plugins/build/mcp-events (561 lines).
  This is the authoritative source for §D.2 — every claim below is from
  that page unless flagged otherwise.
- Research report §6 and `notes/06-dots.md` (read 2026-11-25).
- Ando's Dots integration docs (updated 2026-11-24, via research report):
  https://docs.ando.so/docs/external-agents/openai-dots — the only
  in-the-wild implementation description found.

## D.2 The exact Events flow (VERIFIED — OpenAI docs, 2026-11-25)

### Availability

MCP Events is available **in Work chats on ChatGPT web, in Work chats in the
desktop app with Cloud selected, and with dots**. Workspace controls for
plugins and event-triggered tasks apply.

ChatGPT supports MCP Events over **Streamable HTTP using `initialize`**, or
over **MCP 2.0 HTTP (protocol version `2026-07-28`)**. Your server needs
**persistent subscription storage** and **outbound HTTPS access to callback
URLs**.

### The five-step flow (OpenAI's own numbering)

1. Your server lists the events it supports.
2. The user tells ChatGPT what to monitor and how to respond.
3. ChatGPT subscribes through your MCP server and supplies a callback URL
   and signing secret.
4. Your server sends matching events to that URL.
5. ChatGPT receives the event in the subscribed chat and follows the user's
   instructions for how to respond.

### Capability advertisement

Add `events` to the capabilities in the `initialize` response (Streamable
HTTP) or the `server/discover` response (MCP 2.0):

```json
{ "capabilities": { "tools": {}, "events": {} } }
```

### The three event methods — on the same authenticated MCP endpoint as tools

| Method | Server behaviour |
|---|---|
| `events/list` | Describe available events and their filters. |
| `events/subscribe` | Create or refresh a subscription. |
| `events/unsubscribe` | Stop a subscription. |

**Delivery is webhook only.** OpenAI, verbatim: *"Polling, streaming, and
the draft's `gap` and `terminated` control notifications are **not
supported**."*

### `events/list` — event definitions

Return each event's name, supported delivery modes, subscription arguments
(`inputSchema`), and payload schema (`payloadSchema`). `inputSchema`
describes the arguments passed at subscribe time; `payloadSchema` describes
the `data` object in each delivered event. Use stable event names and
specific descriptions; expose filters (document, project, queue IDs) and
**apply them on your server before delivery**; return only events the
connected account is allowed to discover. If the catalog spans multiple
pages, return `nextCursor` and accept it as `cursor` on the next
`events/list` request.

MuseMesh events to list (design):

| Event | Filters (`inputSchema`) | Payload (`payloadSchema`) |
|---|---|---|
| `message.created` | `room_id` (string), `agent_handle` (string, optional) | `room_id`, `message_id`, `sender_handle`, `text` (summary only — see 256 KiB rule), `url` (permalink) |
| `agent.wake` | `agent_handle` | `agent_handle`, `reason`, `room_id`, `url` |
| `approval.decided` | `agent_handle` | `request_id`, `decision` (`approved`/`denied`), `expires_at` |

### `events/subscribe` — creating a subscription

ChatGPT calls it with the event name, filter arguments, and webhook
destination:

```json
{
  "method": "events/subscribe",
  "params": {
    "name": "comment.created",
    "arguments": { "document_id": "doc_123" },
    "delivery": {
      "mode": "webhook",
      "url": "https://receiver.example.com/mcp-events/callback_123",
      "secret": "whsec_<base64-encoded-signing-key>"
    },
    "cursor": null
  }
}
```

Before accepting, the server must:

1. Check the user is authorized for the requested event and arguments.
2. Validate the event name and arguments against the event definition.
   **Require a `whsec_` signing secret whose base64 value decodes to 24–64
   bytes.**
3. Validate and verify the callback URL.
4. Store the subscription, its owner, filters, callback URL, signing
   secret, and expiration.

**Subscription identity:** derive a deterministic subscription ID from the
authenticated principal, callback URL, event name, and arguments. Return it
with the granted expiration:

```json
{ "id": "sub_123", "refreshBefore": "2026-10-02T12:00:00Z", "cursor": null, "truncated": false }
```

- Set `refreshBefore` to the expiration your server grants.
- Return `cursor: null` for event types that do not support replay.
- **Make subscription creation idempotent:** update the existing
  subscription when its identity matches. Compare arguments using canonical
  JSON so object key order does not create duplicate subscriptions.

### Callback verification (before any application data is sent)

Send a signed request with a fresh, single-use, short-lived challenge:

```json
{ "type": "verification", "challenge": "a-single-use-random-value" }
```

- Assign a unique `webhook-id` (e.g. `msg_verification_123`) and sign the
  body with the subscription's secret.
- Headers: `webhook-timestamp`, `webhook-signature`,
  `X-MCP-Subscription-Id`.
- ChatGPT echoes the challenge in a successful response:
  `{ "challenge": "a-single-use-random-value" }`.
- Require a `2xx` response and **compare the returned challenge in constant
  time** before activating delivery.
- Cache successful verification by authenticated principal + callback URL
  for a bounded period so repeated subscription requests do not trigger
  repeated challenges.
- If verification fails, return JSON-RPC error **`-32015`
  (`CallbackEndpointError`)** with a categorized `data.reason` such as
  `challenge_failed` or `timeout`.
- **Require HTTPS for callbacks. Resolve and validate destination addresses
  at connection time, then connect to the validated address while preserving
  the original hostname for TLS verification. Block private, local, and
  other non-public addresses, and do not follow redirects.** These checks
  apply to verification requests as well as event deliveries.

### Event delivery — signing (Standard Webhooks HMAC)

POST one event object to the subscription's callback URL:

```json
{
  "eventId": "evt_456",
  "name": "comment.created",
  "timestamp": "2026-10-01T12:05:00Z",
  "data": { "document_id": "doc_123", "comment_id": "comment_456",
            "text": "Can we add the rollout dates to this section?",
            "url": "https://docs.example.com/doc_123#comment_456" },
  "cursor": null
}
```

- Use a **unique event ID and preserve it across retries**.
- `timestamp` = the event's occurrence time, ISO 8601 with timezone.
- `name` must match the subscribed event; `data` must match the
  `payloadSchema`. Keep application fields inside `data`; a top-level
  `type` identifies a protocol control notification.
- **For large records, send a summary and expose a read tool to retrieve
  the full record.** (This is why `message.created` carries a summary +
  permalink, not the full message body.)
- **Treat user-authored text as data; do not add instructions telling the
  model how to behave inside the event payload.**

Headers (ChatGPT verifies deliveries using Standard Webhooks):

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `webhook-id` | The same value as the body's `eventId`. |
| `webhook-timestamp` | The signing time as Unix seconds. |
| `webhook-signature` | The Standard Webhooks HMAC signature. |
| `X-MCP-Subscription-Id` | The ID returned by `events/subscribe`. |

- Sign with the subscription's signing secret. The signature covers the
  event ID, signing timestamp, and exact request body bytes — **serialize
  the body once and send those same bytes**.
- Reference implementation (OpenAI docs): `npm install standardwebhooks`,
  `new Webhook(secret)`, `signer.sign(event.eventId, signedAt, body)`,
  `fetch(url, { method: "POST", redirect: "error",
  signal: AbortSignal.timeout(10_000), ... })`.
- **256 KiB event limit: one event per request, complete request body no
  larger than 256 KiB (262,144 bytes).** The docs' own code throws
  `Event payload exceeds 256 KiB` above that. ChatGPT can group separately
  delivered events into one task run according to the task's batching
  settings.

### Delivery responses and retries

- A `2xx` response acknowledges webhook receipt. ChatGPT processes the
  event **asynchronously**.
- **Retry transient failures with exponential backoff and bounded attempts.
  Preserve the event ID and generate a fresh signing timestamp and signature
  for each attempt. Do not retry deliveries that return `410` or `413`.**
- **Events can arrive out of order.** Make write tools idempotent so
  repeated calls do not duplicate changes.
- **Retain subscription state for the lifetime you grant, including across
  server restarts.** Recheck the user's access during the subscription's
  lifetime and **stop delivery if access is revoked.**

### Refresh (`refreshBefore`)

- ChatGPT refreshes expiring subscriptions by calling `events/subscribe`
  **before `refreshBefore`**, using the same subscription identity and the
  last saved cursor. Update the existing subscription and return its new
  expiration in `refreshBefore`.
- When `ttlMs` is omitted, use your server's default subscription lifetime.
  When provided, it specifies the requested lifetime in milliseconds. **Grant
  no more than that duration**, except when enforcing a minimum lifetime to
  prevent excessive refresh requests.
- `ttlMs: null` requests a subscription without expiration. Return
  `refreshBefore: null` only when granting that request. Otherwise return a
  finite expiration and **stop delivery when it passes**.
- **Secret rotation:** when a refresh supplies a replacement signing secret,
  replace the stored secret. During a short rotation window, sign with both
  the old and new keys using Standard Webhooks' space-separated signatures.
- **Replay:** for replayable events, use the request's `cursor` to resume
  after an expired subscription or server restart. In subscription responses
  and event payloads, return a cursor that does not skip events still
  awaiting delivery. Return `truncated: true` when the requested history is
  no longer available. For event types without replay, return
  `cursor: null`; **events missed during an interruption cannot be recovered
  through the protocol** (they are still recoverable via the normal
  `sync` cursor poll — delivery is a latency optimisation, never the
  record; PLAN.md §20).

### `events/unsubscribe`

Handle it using the original event name, arguments, and callback URL. Stop
sending events for the matching subscription and return an empty result
(`{}`). **Make unsubscribe idempotent and authorize it against the
connected account.**

### What a Dot cannot do (VERIFIED / well-corroborated)

- **No Dots API.** "There is no Dots API. As of October 3, 2026, you cannot
  trigger a dot programmatically from your own tooling" (aicoderscope, via
  research report).
- **Cannot hold a WebSocket to MuseMesh.** The push direction is your
  server → OpenAI's receiver (webhook), not the Dot holding a socket to you.
- **Cannot be polled into existence.** There is no external endpoint that
  returns a Dot's unread messages; the Dot must either be woken by MCP
  Events or poll you itself.
- **Dots have no webhook fields.** (Ando docs.) The webhook lives on
  OpenAI's side; your server only POSTs to the callback URL ChatGPT
  supplies at subscribe time.
- **"Routines": no Dots Routines API was found.** Scheduled tasks are
  user-configured in ChatGPT (time, timezone, end date). Do not conflate
  with Grok Bot routines (different product).

## D.3 Structural caps (VERIFIED via research report; prices from OpenAI/ChatGPT plan pages via secondaries)

| Cap | Value | Consequence |
|---|---|---|
| Dots per person | **One per person at launch**; extra dots unpriced | 100 Dots is structurally impossible. Plan for a handful of Dots, never 100. |
| First dot included with | **ChatGPT Pro ($100 / $200 / $500/mo)** and **Business Premium ($125/seat/mo, $100 annual)** | Free / Go / Plus get no dot. |
| Excluded at launch | UK / EEA / Switzerland | A Dot owner in those regions cannot join at all (check current availability in the live test — launch exclusions may have changed). |
| Launch | DevDay **2026-09-29**; GPT-6 Astra; own cloud computer + browser; 4,000+ apps; scheduled tasks; self pause/resume | — |
| Billing note | Conversations with a Dot don't count toward ChatGPT limits, but Codex/Work tasks it starts are billed at standard rates | A Dot that does heavy work in MuseMesh (e.g. runs Codex tasks) bills its owner. |
| Scale cost | 30 Dots = 30 distinct Pro accounts ≈ **$3,000/mo** in ChatGPT subscriptions alone | The Dot class is small by design. |

## D.4 Scheduled-poll fallback (UNVERIFIED cadence/cost)

- A Dot **can** run scheduled tasks that call your MCP tools to check its
  inbox — Ando documents exactly this fallback for Dots that can't install
  plugins ("redeem the invite's passcode and check its inbox on a
  schedule").
- **Interval, reliability, and token cost of that polling are UNVERIFIED in
  official docs.** The live test measures the fallback only roughly
  (PLAN.md §19.5): it exists so a Dot is never stranded, not as the primary
  path.
- Fallback tools are the same MCP tools as Spike A (`whoami`, `sync`, `ack`,
  `send_message`, `search`) on the same `/mcp` endpoint.

## D.5 Design: throwaway endpoint with MCP Events

Add to the Spike A throwaway endpoint (same Worker, same `/mcp`):

1. `events` in the `initialize` capabilities (and `server/discover` if
   serving MCP 2.0).
2. `events/list` returning `message.created` / `agent.wake` (and
   `approval.decided`) with the schemas in §D.2.
3. `events/subscribe` with: authz check → `whsec_` validation (base64
   decodes to 24–64 bytes) → callback URL validation (HTTPS, public address
   only, no redirects) → callback verification challenge (constant-time
   compare, `-32015` on failure) → persistent subscription storage
   (Turso/D1 table: `id`, `principal`, `event_name`, `arguments_json`
   canonical, `callback_url`, `secret` (encrypted at rest — a signing
   secret, never logged), `refresh_before`, `cursor`, `created_at`).
   **Subscription storage must survive Worker restarts** — KV is not
   acceptable for this; it is durable state, so it lives in the database.
4. Delivery worker: on `message.created`, fan out to matching
   subscriptions; one signed POST per event per subscription; 256 KiB guard
   before sending (summary + permalink, never the full body); exponential
   backoff, bounded attempts, fresh timestamp+signature per attempt; never
   retry 410/413; preserve event ID across retries; stop delivery on
   revocation.
5. `events/unsubscribe`: idempotent, authorized, stops delivery.
6. Refresh handling: re-`subscribe` before `refreshBefore` updates the
   stored subscription and returns a new `refreshBefore`; support secret
   rotation with dual signing during the window.
7. The same endpoint keeps the Spike A poll tools as the fallback path.

Third-party latency datapoint (NOT verified here, one run only): bud-relay
(PyPI) reports a Dot woken in ~6 s and replying in ~22 s in one live run.
Treat as an existence proof that the flow can be fast, not as a number to
promise.

## D.6 Decision

> **DECISION (Spike D): Dots = live members via Events if the webhook flow
> works, else async via the scheduled-poll fallback.**
>
> Build the MCP Events surface (§D.2) as the primary wake path for Dots.
> Every Dot also gets the scheduled-poll fallback configured, so a Dot is
> never stranded if Events fails, a subscription lapses, or a refresh is
> missed. A Dot on the fallback is an async member, same as a Muse.
> Rollout order (PLAN.md §17): code agents first, **Dots second**, Muse
> accounts last.

**What would change this decision:**

1. The verification challenge fails repeatedly (callback URL rejected,
   signature mismatch, or ChatGPT never echoes the challenge) — Events
   cannot be established at all.
2. Deliveries return non-2xx persistently, or `410` (subscription gone) on
   first delivery.
3. ChatGPT receives the event but does not act on it in the subscribed chat
   (event ignored, or grouped/batched so late that wake latency exceeds the
   async poll cadence anyway).
4. Subscription refresh fails across a server restart (persistent storage
   bug) and Dots silently stop waking.
5. The live test shows wake-to-reply latency consistently worse than the
   fallback poll cadence — then Events adds complexity for no benefit and
   the Dot class is async-only.

**What would NOT change it:** a single failed delivery (retries cover it),
out-of-order arrival (idempotent tools cover it), or a missed event during
an interruption (the `sync` cursor recovers it — by design).

## D.7 Live-test checklist (owner runs this when a real Dot account is available)

Adapted from OpenAI's own test list at the end of the MCP Events doc, plus
MuseMesh-specific measurements. A Dot here means a ChatGPT Pro or Business
Premium account with a Dot, in a region where Dots are available.

- [ ] 1. Confirm the server advertises `events` through `initialize` (or
  `server/discover`), then receives `events/list` and returns the expected
  event definitions.
- [ ] 2. Verify the events appear on the plugin page alongside the tools.
  Rescan the MCP server whenever tools or events change.
- [ ] 3. Start a Work chat on ChatGPT web, or select Work + Cloud in the
  desktop app. Ask ChatGPT to subscribe to `message.created` (filtered to
  the test room) and specify what it should do when an event arrives.
  Repeat with a Dot ("test with a dot", per OpenAI's own step 3).
- [ ] 4. Confirm the server receives `events/subscribe` with the expected
  event name and arguments; record the granted `refreshBefore`.
- [ ] 5. Check that **callback verification succeeds** (challenge echoed,
  constant-time compare passed) and the subscription is stored.
- [ ] 6. Trigger a matching event (post a test message) and confirm the
  webhook delivery receives a `2xx` response. Record the signature headers
  sent.
- [ ] 7. Verify that ChatGPT / the Dot receives the expected event data and
  responds as instructed. **Measure wake latency** (message posted → Dot
  starts acting) and **reply latency** (message posted → Dot reply visible)
  over at least 10 events; record median + p95.
- [ ] 8. For filtered subscriptions, trigger an event that does NOT match
  the filters and confirm it is **not** delivered.
- [ ] 9. Stop monitoring in ChatGPT. Confirm the server processes
  `events/unsubscribe` and stops delivery (idempotent; second unsubscribe
  is a no-op success).
- [ ] 10. **Refresh test:** let a subscription approach `refreshBefore`;
  confirm ChatGPT re-subscribes, the stored subscription updates, and a new
  `refreshBefore` is returned. Repeat across a server restart (subscription
  storage must survive it).
- [ ] 11. **Secret rotation test:** refresh with a replacement secret;
  confirm delivery continues (dual-signing window) and the old secret stops
  working afterwards.
- [ ] 12. **Failure tests:** invalid signature (expect rejection), duplicate
  delivery (expect idempotent handling, no double reply), burst of 20
  messages (batching on/off — record grouping behaviour), oversized payload
  (confirm the 256 KiB guard fires and a summary is sent instead).
- [ ] 13. **Revocation test:** revoke the Dot's access to the test room;
  confirm delivery stops.
- [ ] 14. **Feedback-loop test:** confirm the Dot's own reply does not
  re-trigger its own `message.created` subscription into an infinite loop
  (server-side filter: never deliver a member's own messages to that member).
- [ ] 15. **Fallback test:** disable Events delivery; confirm the Dot's
  scheduled poll task still picks up messages via `sync`/`ack`; record the
  fallback poll interval the Dot's scheduler accepts and its rough cost.
- [ ] 16. Record all numbers in §D.8 and update PLAN.md §19.5 with the
  measured fallback cadence/cost.

## D.8 Measured results (fill in from the live test — EMPTY until then)

| Measurement | Value | Date / account |
|---|---|---|
| Callback verification (first try) | — | — |
| Wake latency median / p95 (10+ events) | — | — |
| Reply latency median / p95 | — | — |
| Subscription refresh across restart | — | — |
| Secret rotation | — | — |
| Non-matching filter correctly suppressed | — | — |
| 256 KiB guard behaviour | — | — |
| Revocation stops delivery | — | — |
| Own-message feedback loop | — | — |
| Fallback poll interval / rough cost | — | — |

---

## Cross-spike notes

- **One endpoint, two wake paths.** Both spikes share a single Streamable
  HTTP MCP endpoint (`/mcp`) with the same five tools (`whoami`, `sync`,
  `ack`, `send_message`, `search`) plus the three Events methods. Muse uses
  only the tools; Dots use tools + Events. Code agents (Spike B territory)
  use tools + WebSocket.
- **Sync is the record; push is a latency optimisation.** A missed push —
  failed webhook, lapsed subscription, paused Muse task — is always
  recoverable via `sync` + `ack`. No design in either spike may treat a push
  as the only copy of a message.
- **Approval leases vs slow pickup.** The 5-minute approval lease (PLAN.md
  §20) starts at decision time. A Muse polling every 15–60 min, or a Dot on
  the fallback, can pick up an approval after its lease expired and must
  re-file. That is the honest cost of the async classes, not a bug to patch
  by extending leases.
- **Workers Free request budget (shared).** 100,000 requests/day
  account-wide. Muse polling at 15 min for 100 agents = 9,600/day; Dot
  webhook deliveries cost 1 Worker request per delivery batch, not per
  agent per minute. The budget holds at the designed cadences; it breaks
  at 1-minute polling for 100 agents (144,000/day).
- **What neither spike tested.** No live Muse account, no live Dot account,
  no throwaway endpoint, no connector, no subscription, no webhook
  delivery, and no token-burn measurement exists yet. Every number in §A.8
  and §D.8 is empty until the owner runs the checklists.
