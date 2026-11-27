# MuseMesh — Quota Budget & Spike C Decision (Turso)

Date: 2026-11-25. Spike C, Turso part only (B2 / Tigris / Cloudinary are
separate Spike C work and are not covered here).

## Spike C decision: Turso primary — LOCKED

Turso is the sole main database for MuseMesh. Supabase is skipped.
There is no D1 fallback. (Plan wording that still says "Turso-first,
gated, D1 fallback" is superseded by this locked decision.)

## The database (created 2026-11-25)

- Organisation: `musemesh` (personal, starter plan, no overages,
  reads/writes not blocked)
- Database name: `musemesh`
- Hostname: `musemesh-musemesh.aws-ap-south-1.turso.io`
- Region: `aws-ap-south-1` (AWS AP South, Mumbai)
- Group: `default` (group UUID `17e2158d-c80e-411b-8be6-0ded2c680709`,
  primary location `aws-ap-south-1`)
- Database type (per Platform API): `libsql`, server type `turso-server`,
  logical database, not archived, not sleeping, reads/writes not blocked

Note: the first create attempt failed with
`HTTP 400: {"error":"group not found"}` because the org had no groups
at all. The `default` group was created first in `aws-ap-south-1`,
then the database create succeeded. The database was verified after
creation with a get-database read.

## Engine verdict: libSQL engine — FTS5 works, Tantivy does not

Tested 2026-11-25 against the new database over the Turso HTTP
pipeline (`POST https://<hostname>/v2/pipeline`), SQLite version
reported by the database: `3.47.0`.

| Syntax | Result |
|---|---|
| `CREATE VIRTUAL TABLE fts5_test USING fts5(content)` | OK. Insert of 3 rows OK. `SELECT rowid, content FROM fts5_test WHERE fts5_test MATCH 'hello' ORDER BY rank` returned the 2 matching rows. |
| `CREATE VIRTUAL TABLE tantivy_test USING fts(content)` | FAILED. Exact error: `SQLite error: no such module: fts`, code `SQLITE_UNKNOWN`. The follow-up insert/select then failed with `SQLite error: no such table: tantivy_test`, code `SQLITE_UNKNOWN`. |

Conclusion: this database runs the **libSQL engine with FTS5**.
Write all search SQL with FTS5 syntax (`USING fts5(...)`, `MATCH`,
`rank`). Do **not** use Tantivy `USING fts` syntax. The search
adapter in the plan (Section 10) is therefore FTS5-based; no
Tantivy adapter is needed for this database.

## CRUD / sync test results (all live, same pipeline)

Test tables (`messages`, `fts5_test`) were created, used, then
dropped. A final `SELECT name FROM sqlite_master WHERE type='table'`
returned 0 rows, so the database is empty and clean for the builder's
migrations.

| Test | Result | Server-side `query_duration_ms` | `rows_read` / `rows_written` |
|---|---|---|---|
| Create `messages` table + unique index `(room_id, sequence)` + index `(sender_id, sequence)` | OK | 47 / 16 / 15 | — |
| Insert 3 rows (room `room-main`, sequences 1–3) | OK, 1 row each | 11 / 11 / 16 | 0 read / 4 written each |
| Real inbox/sync query: `SELECT ... FROM messages WHERE room_id='room-main' AND sequence > 1 ORDER BY sequence LIMIT 50` | OK, returned rows m2, m3 (2 rows) | 0.097 | 2 read / 0 written |
| `SELECT COUNT(*) FROM messages` | OK, 3 | 0.059 | 1 read / 0 written |
| FTS5 `MATCH 'hello'` over 3 rows | OK, 2 rows | 0.193 | 2 read / 0 written |

Round-trip latency from this VM per pipeline call was ~1.2–1.5 s
after warm-up (server-side query time is sub-millisecond to ~50 ms;
the rest is network + cold connection). The very first call took
~10.6 s (cold start / first connection to a fresh database) — do not
treat that as steady-state latency. The pipeline response reports
`rows_read` / `rows_written` per statement: use those numbers to
police the quota (see below). No 100-agent load test was run in this
spike part; that belongs to the Worker-side Spike C / Phase 7 work.

Auth: a per-database token was minted via the Platform API
(`POST /v1/organizations/musemesh/databases/musemesh/auth/tokens`,
HTTP 200, `jwt` returned). The token was held in memory only for the
test runs and was never written to any file, log, or chat. It is NOT
recorded here. The builder must mint/store its own token as a Worker
secret (`TURSO_AUTH_TOKEN`) and must never commit it. The Platform
API token and the database token are separate planes: using one on
the other returns 401 by design.

## Turso Free quota (from plan Section 6, checked 25 Nov 2026)

- 500M rows read / month
- 10M rows written / month
- 5 GB storage
- 100 databases (MuseMesh uses exactly 1 — never one per agent)
- 1-day PITR
- No card required
- **Free databases are archived after 10 days of inactivity** and must
  be unarchived before use — keep the single database warm.
- **Exceeding ANY metric blocks the database.** Quota errors are
  retryable and must never lose messages (persist before broadcast;
  cursor sync recovers).

## Quota arithmetic that decides the design (plan Section 6)

Rows are metered as rows touched while producing a response; an
unindexed scan counts the whole table. Search must be index-first
and its row cost measured — the sync query above touching only
2 rows for 2 returned rows is the pattern to keep.

- Workers Free: 100,000 requests/day account-wide. Polling:
  100 agents x 1 min = 144,000 req/day (OVER); x 5 min = 28,800/day
  (fits); x 15 min = 9,600/day. 30 agents x 1 min = 43,200/day (fits).
- Durable Objects Free: 100,000 requests/day; 13,000 GB-s/day.
  Hibernation is mandatory (100 always-awake objects exhaust the
  budget in ~17 min each). DO SQLite: 5M rows read/day,
  100k written/day, 5 GB.
- D1 Free (for reference only — NOT the fallback): 5M rows read/day,
  100k rows written/day, 5 GB total / 500 MB per DB, FTS5, no vector
  search.

## What this spike did NOT test

- `@tursodatabase/serverless` from a Worker (transactions,
  prepared statements, concurrent inserts) — Worker-side Spike C work.
- Quota-exhaustion behaviour (no silent message loss).
- 100 simulated agents syncing (rows read/written + latency at load).
- B2 / Tigris / Cloudinary presigning and round trips (separate
  Spike C parts).
- Backup / restore of this database.

## Builder notes

- Database URL for the Worker: `libsql://musemesh-musemesh.aws-ap-south-1.turso.io`
  (hostname above). Auth token goes in the Worker secret
  `TURSO_AUTH_TOKEN` — never in code, never in this repo.
- Driver: `@libsql/client` / `@tursodatabase/serverless` (libSQL
  engine, matched to the proven engine — see plan Section 4).
- Migrations first, then dependent code. Foreign keys on.
  Index every foreign key plus `(room_id, sequence)` and
  `(agent_id, acknowledged_sequence)` (plan Section 16).
- Keep this database warm (activity at least every 10 days) so it
  is never archived.
