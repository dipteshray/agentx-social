#!/usr/bin/env python3
"""Back up the live AgentX Social Turso database (`musemesh`) to a local dump.

Reads ONLY — never writes to the live DB. Mints a short-lived per-database
token via the Turso Platform API (using the registered custom.turso
credential) and uses it in-process to read every row over the Turso HTTP
pipeline. The token is never printed, logged, or saved anywhere — it lives
only in this process.

Dump format: JSON, one file per run:
    ~/workspace/musemesh-build/backups/musemesh-YYYYMMDD-HHMMSS.json
    {"meta": {...}, "tables": {"agents": {"columns": [...], "rows": [[...]]}}}
Blobs are stored as {"$blob": "<base64>"}.

The FTS5 virtual table `search_documents` (and its shadow tables) is NOT
dumped — it is derived data. scripts/restore-turso.py rebuilds it from the
restored messages (public rooms only, exactly like the Worker does on post).

The dump contains password hashes (salt:sha256, never plaintext passwords)
and agent token verifiers (SHA-256, never raw tokens). Treat dump files as
sensitive: they are written mode 0600, live OUTSIDE the git repo, and must
never be committed, pasted into chat, or shared.

Usage:
    python3 scripts/backup-turso.py [--keep N] [--out-dir DIR]
Keeps the last N dumps (default 7), pruning older ones. Prints only per-table
row counts, the file path, and the file size — no row data, no tokens.
"""
import base64
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone, timedelta

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request

ORG = os.environ.get("TURSO_ORG", "musemesh")
DB = os.environ.get("TURSO_DB", "musemesh")
BACKUP_DIR = os.path.expanduser("~/workspace/musemesh-build/backups")
UA = "Muse/1.0 (custom-connector; +https://muse.ai)"
IST = timezone(timedelta(hours=5, minutes=30))
PAGE = 500

# FK-safe dump order (parents before children). Tables not listed here are
# dumped after these, alphabetically. FTS5 tables are excluded entirely.
TABLE_ORDER = [
    "owner_account", "agents", "agent_tokens", "agent_invites", "rooms",
    "room_members", "messages", "message_events", "agent_cursors",
    "room_read_state", "room_pins", "follows", "attachments", "reactions",
    "room_invites", "room_slug_aliases", "audit_logs", "idempotency_keys",
    "trade_payloads", "approval_requests", "approval_rules", "agent_usage",
    "sequences",
]


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
    """stmts: list of (sql, args) where args are hrana-typed dicts."""
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


def rows_of(result):
    """Unwrap one pipeline execute result into plain Python values."""
    if result.get("type") == "error":
        raise SystemExit(f"Turso query failed: {result['error']}")
    res = result["response"]["result"]
    out = []
    for row in res.get("rows", []):
        vals = []
        for cell in row:
            t, v = cell.get("type"), cell.get("value")
            if t == "null" or v is None:
                vals.append(None)
            elif t == "integer":
                vals.append(int(v))
            elif t == "float":
                vals.append(float(v))
            elif t == "blob":
                vals.append({"$blob": v})
            else:
                vals.append(v)
        out.append(vals)
    return out


def main():
    keep = 7
    out_dir = BACKUP_DIR
    global ORG, DB
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "--keep" and i + 1 < len(args):
            keep = int(args[i + 1]); i += 2
        elif args[i] == "--out-dir" and i + 1 < len(args):
            out_dir = os.path.expanduser(args[i + 1]); i += 2
        elif args[i] == "--org" and i + 1 < len(args):
            ORG = args[i + 1]; i += 2
        elif args[i] == "--db" and i + 1 < len(args):
            DB = args[i + 1]; i += 2
        else:
            print(f"Unknown argument: {args[i]}", file=sys.stderr); sys.exit(1)

    os.makedirs(out_dir, exist_ok=True)
    now = datetime.now(IST)
    stamp = now.strftime("%Y%m%d-%H%M%S")

    print(f"Minting a short-lived DB token for {ORG}/{DB} (read-only use) ...")
    token_resp = turso_platform(f"/v1/organizations/{ORG}/databases/{DB}/auth/tokens",
                                method="POST", body={})
    token = token_resp.get("jwt")
    if not token:
        raise SystemExit(f"Token mint returned no jwt (keys: {sorted(token_resp.keys())})")
    # Resolve the database URL from the Platform API (never hardcoded).
    info = turso_platform(f"/v1/organizations/{ORG}/databases/{DB}")
    info = info.get("database", info)
    db_url = "https://" + info["hostname"]
    print(f"Target DB: {ORG}/{DB} at {db_url}")

    # Table list, excluding sqlite internals and the FTS5 virtual table +
    # its shadow tables (derived data, rebuilt on restore).
    data = pipeline(token, db_url, [(
        "SELECT name FROM sqlite_master WHERE type='table' "
        "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'search_documents%' "
        "ORDER BY name", [])])
    tables = [r[0] for r in rows_of(data["results"][0])]
    ordered = [t for t in TABLE_ORDER if t in tables] + \
              [t for t in tables if t not in TABLE_ORDER]
    missing = [t for t in TABLE_ORDER if t not in tables]
    if missing:
        print(f"Note: expected tables absent from live DB: {', '.join(missing)}")

    dump = {"meta": {
        "database": DB, "db_url": db_url, "backed_up_at_ist": now.isoformat(),
        "generator": "scripts/backup-turso.py",
        "note": "FTS5 search_documents excluded (derived, rebuilt on restore). "
                "Contains password hashes and token verifiers, never plaintext "
                "passwords or raw tokens. Keep mode 0600, never commit.",
    }, "tables": {}}
    counts = {}
    for table in ordered:
        cols_data = pipeline(token, db_url, [(f'PRAGMA table_info("{table}")', [])])
        columns = [r[1] for r in rows_of(cols_data["results"][0])]
        all_rows = []
        offset = 0
        while True:
            page = pipeline(token, db_url, [(
                f'SELECT * FROM "{table}" ORDER BY rowid LIMIT {PAGE} OFFSET {offset}', [])])
            batch = rows_of(page["results"][0])
            all_rows.extend(batch)
            if len(batch) < PAGE:
                break
            offset += PAGE
        dump["tables"][table] = {"columns": columns, "rows": all_rows}
        counts[table] = len(all_rows)

    path = os.path.join(out_dir, f"{DB}-{stamp}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(dump, f, ensure_ascii=False)
    os.chmod(path, 0o600)

    # Prune older dumps, keep the newest `keep`.
    dumps = sorted(
        (os.path.join(out_dir, n) for n in os.listdir(out_dir)
         if n.startswith(f"{DB}-") and n.endswith(".json")),
        key=os.path.getmtime)
    pruned = []
    while len(dumps) > keep:
        old = dumps.pop(0)
        os.remove(old)
        pruned.append(os.path.basename(old))

    total = sum(counts.values())
    print(f"Backup of {DB} at {now.strftime('%Y-%m-%d %H:%M:%S IST')}:")
    for table in ordered:
        print(f"  {table}: {counts[table]}")
    print(f"  TOTAL rows: {total}")
    print(f"  File: {path}")
    print(f"  Size: {os.path.getsize(path)} bytes")
    if pruned:
        print(f"  Pruned older dumps (kept last {keep}): {', '.join(pruned)}")
    print("Token was used in-process only and is discarded.")


if __name__ == "__main__":
    main()
