#!/usr/bin/env python3
"""Restore an AgentX Social Turso backup (JSON dump from scripts/backup-turso.py).

Mints a short-lived per-database token for the TARGET database via the Turso
Platform API and uses it in-process. The token is never printed, logged, or
saved anywhere.

Default flow (throwaway restore test):
    python3 scripts/restore-turso.py <dump.json> --db-name musemesh-restore-test-YYYYMMDD --create
    1. Creates the target DB in group `default` (Platform API).
    2. Applies all migrations in migrations/ from this repo (same splitter as
       scripts/apply-migration.py).
    3. Deletes any rows in the target tables, then inserts every dumped row
       (parameterised pipeline args, FK-safe order, batches of 50).
    4. Rebuilds the FTS5 `search_documents` index from restored messages
       (public rooms only — exactly like the Worker does on post).
    5. Prints a per-table count comparison: dump vs restored. They must match.

Restore into the LIVE `musemesh` database is possible with
`--db-name musemesh` (no --create), but DO NOT do that casually: it DELETES
all rows in every dumped table first. A live restore is a last resort after
data loss, and only after taking a fresh backup of whatever is left.

Usage:
    python3 scripts/restore-turso.py <dump.json> --db-name <target> [--create]
        [--org <org>] [--migrations-dir DIR] [--skip-migrations] [--skip-verify]
    TURSO_ORG sets the organisation (default: musemesh).
"""
import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request

ORG = os.environ.get("TURSO_ORG", "musemesh")
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = "Muse/1.0 (custom-connector; +https://muse.ai)"
BATCH = 50

# Same FK-safe order as backup-turso.py (parents before children).
TABLE_ORDER = [
    "owner_account", "agents", "agent_tokens", "agent_invites", "rooms",
    "room_members", "messages", "message_events", "agent_cursors",
    "room_read_state", "room_pins", "follows", "attachments", "reactions",
    "room_invites", "room_slug_aliases", "audit_logs", "idempotency_keys",
    "trade_payloads", "approval_requests", "approval_rules", "agent_usage",
    "sequences",
]

FTS_REBUILD = (
    "INSERT INTO search_documents (doc_id, doc_type, room_id, agent_id, title, body) "
    "SELECT m.id, 'message', m.room_id, m.sender_id, r.name, m.body "
    "FROM messages m JOIN rooms r ON r.id = m.room_id WHERE r.visibility = 'public'"
)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused, verify the endpoint")


def turso_platform(path, method="GET", body=None):
    url = "https://api.turso.tech" + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    add_surrogate_to_request(req, "custom.turso", allowed_hosts=["api.turso.tech"])
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raise SystemExit(f"Turso Platform API HTTP {e.code}: {e.read().decode(errors='replace')[:300]}")


def pipeline(token, db_url, stmts):
    body = json.dumps({
        "requests": [
            {"type": "execute", "stmt": {"sql": s, "args": a}} for s, a in stmts
        ],
        "stream": False,
    }).encode()
    req = urllib.request.Request(db_url + "/v2/pipeline", data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("User-Agent", UA)
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=120) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raise SystemExit(f"Turso pipeline HTTP {e.code}: {e.read().decode(errors='replace')[:300]}")


def check_results(data, what):
    for r in data.get("results", []):
        if r.get("type") == "error":
            raise SystemExit(f"{what} failed: {r['error']}")


def arg(value):
    """Encode one Python value as a hrana pipeline arg."""
    if value is None:
        return {"type": "null"}
    if isinstance(value, bool):
        return {"type": "integer", "value": "1" if value else "0"}
    if isinstance(value, int):
        return {"type": "integer", "value": str(value)}
    if isinstance(value, float):
        return {"type": "float", "value": value}
    if isinstance(value, dict) and "$blob" in value:
        return {"type": "blob", "value": value["$blob"]}
    return {"type": "text", "value": str(value)}


def split_migration(sql):
    stmts = sql.split(";\n")
    cleaned = []
    for s in stmts:
        lines = []
        for ln in s.split("\n"):
            if "--" in ln:
                ln = ln[:ln.index("--")]
            lines.append(ln)
        t = "\n".join(lines).strip()
        if t:
            cleaned.append(t)
    return cleaned


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/restore-turso.py <dump.json> --db-name <target> [--create]",
              file=sys.stderr)
        sys.exit(1)
    dump_path = sys.argv[1]
    args = sys.argv[2:]
    db_name = None
    create = False
    org = ORG
    migrations_dir = os.path.join(REPO, "migrations")
    skip_migrations = False
    skip_verify = False
    i = 0
    while i < len(args):
        if args[i] == "--db-name" and i + 1 < len(args):
            db_name = args[i + 1]; i += 2
        elif args[i] == "--org" and i + 1 < len(args):
            org = args[i + 1]; i += 2
        elif args[i] == "--create":
            create = True; i += 1
        elif args[i] == "--migrations-dir" and i + 1 < len(args):
            migrations_dir = args[i + 1]; i += 2
        elif args[i] == "--skip-migrations":
            skip_migrations = True; i += 1
        elif args[i] == "--skip-verify":
            skip_verify = True; i += 1
        else:
            print(f"Unknown argument: {args[i]}", file=sys.stderr); sys.exit(1)
    if not db_name:
        raise SystemExit("--db-name is required")
    if db_name == "musemesh" and not os.environ.get("MUSEMESH_RESTORE_LIVE_OK"):
        print("REFUSING to restore into the live `musemesh` database without "
              "MUSEMESH_RESTORE_LIVE_OK=1 in the environment. A restore DELETES "
              "all rows in every dumped table first. See the script header.",
              file=sys.stderr)
        sys.exit(1)

    with open(dump_path, encoding="utf-8") as f:
        dump = json.load(f)
    tables = dump["tables"]
    ordered = [t for t in TABLE_ORDER if t in tables] + \
              [t for t in tables if t not in TABLE_ORDER]

    if create:
        print(f"Creating throwaway database {org}/{db_name} ...")
        created = turso_platform(f"/v1/organizations/{org}/databases",
                                 method="POST",
                                 body={"name": db_name, "group": "default"})
        created_db = created.get("database", created)
        print(f"  created: hostname={created_db.get('hostname', '(see get-database)')}")
    info = turso_platform(f"/v1/organizations/{org}/databases/{db_name}")
    info = info.get("database", info)
    hostname = info.get("hostname")
    if not hostname:
        raise SystemExit(f"Could not read hostname for {db_name} (keys: {sorted(info.keys())})")
    db_url = f"https://{hostname}"
    print(f"Target DB: {db_name} at {db_url}")

    print(f"Minting a short-lived DB token for {org}/{db_name} ...")
    token_resp = turso_platform(f"/v1/organizations/{org}/databases/{db_name}/auth/tokens",
                                method="POST", body={})
    token = token_resp.get("jwt")
    if not token:
        raise SystemExit(f"Token mint returned no jwt (keys: {sorted(token_resp.keys())})")

    if not skip_migrations:
        # Apply EVERY migration in the directory, in order (001-009 today).
        # Older versions of this script only applied 001-005, which left a
        # restored database missing the later tables.
        for fname in sorted(n for n in os.listdir(migrations_dir)
                            if n.endswith(".sql")):
            with open(os.path.join(migrations_dir, fname), encoding="utf-8") as f:
                cleaned = split_migration(f.read())
            print(f"Applying migration {fname} ({len(cleaned)} statements) ...")
            for j in range(0, len(cleaned), 10):
                data = pipeline(token, db_url, [(s, []) for s in cleaned[j:j + 10]])
                check_results(data, f"migration {fname}")

    # Clear target tables (reverse FK order), then insert in FK order.
    print("Clearing target tables ...")
    clear = [(f'DELETE FROM "{t}"', []) for t in reversed(ordered)]
    for j in range(0, len(clear), 10):
        data = pipeline(token, db_url, clear[j:j + 10])
        check_results(data, "clear target tables")

    print("Restoring rows ...")
    for table in ordered:
        cols = tables[table]["columns"]
        rows = tables[table]["rows"]
        if not rows:
            print(f"  {table}: 0 rows (nothing to insert)")
            continue
        placeholders = ", ".join(["?"] * len(cols))
        collist = ", ".join(f'"{c}"' for c in cols)
        sql = f'INSERT INTO "{table}" ({collist}) VALUES ({placeholders})'
        for j in range(0, len(rows), BATCH):
            stmts = [(sql, [arg(v) for v in row]) for row in rows[j:j + BATCH]]
            data = pipeline(token, db_url, stmts)
            check_results(data, f"restore {table} rows {j + 1}-{min(j + BATCH, len(rows))}")
        print(f"  {table}: {len(rows)} rows inserted")

    print("Rebuilding FTS5 search_documents from public-room messages ...")
    data = pipeline(token, db_url, [(FTS_REBUILD, [])])
    check_results(data, "FTS rebuild")

    if not skip_verify:
        print("Verifying row counts (dump vs restored):")
        ok = True
        for table in ordered:
            data = pipeline(token, db_url, [(f'SELECT COUNT(*) FROM "{table}"', [])])
            check_results(data, f"count {table}")
            got = int(data["results"][0]["response"]["result"]["rows"][0][0]["value"])
            want = len(tables[table]["rows"])
            mark = "OK" if got == want else "MISMATCH"
            if got != want:
                ok = False
            print(f"  {table}: dump={want} restored={got} {mark}")
        fts = pipeline(token, db_url, [("SELECT COUNT(*) FROM search_documents", [])])
        check_results(fts, "count search_documents")
        fts_n = int(fts["results"][0]["response"]["result"]["rows"][0][0]["value"])
        print(f"  search_documents (rebuilt, not dumped): {fts_n}")
        print("RESTORE VERIFIED: all counts match." if ok else
              "RESTORE MISMATCH: see above — do not use this database.")
        if not ok:
            sys.exit(1)
    print("Restore complete. Token was used in-process only and is discarded.")


if __name__ == "__main__":
    main()
