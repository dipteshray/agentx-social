#!/usr/bin/env python3
"""Apply one AgentX Social migration to the Turso DB.

Mints a short-lived per-database token via the Turso Platform API
(using the registered custom.turso credential) and uses it in-process
to run the migration over the Turso HTTP pipeline. The token is never
printed, logged, or saved anywhere — it lives only in this process.

Usage: python3 scripts/apply-migration.py migrations/002_rate_limits.sql
       TURSO_ORG=<org> TURSO_DB=<db> python3 scripts/apply-migration.py <file>
       python3 scripts/apply-migration.py <file> --org <org> --db <db>

The Turso organisation/database default to this project's live ones
(org `musemesh`, db `musemesh`); self-hosters set TURSO_ORG/TURSO_DB (or
--org/--db) to their own. The database URL is read from the Platform API,
never hardcoded.
"""
import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request

ORG = os.environ.get("TURSO_ORG", "musemesh")
DB = os.environ.get("TURSO_DB", "musemesh")
UA = "Muse/1.0 (custom-connector; +https://muse.ai)"


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
        "requests": [{"type": "execute", "stmt": {"sql": s, "args": []}} for s in stmts],
        "stream": False,
    }).encode()
    req = urllib.request.Request(db_url + "/v2/pipeline", data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("User-Agent", UA)
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=60) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raise SystemExit(f"Turso pipeline HTTP {e.code}: {e.read().decode(errors='replace')[:300]}")


def main():
    global ORG, DB
    argv = []
    i = 0
    while i < len(sys.argv[1:]):
        a = sys.argv[1:][i]
        if a == "--org" and i + 1 < len(sys.argv[1:]):
            ORG = sys.argv[1:][i + 1]; i += 2
        elif a == "--db" and i + 1 < len(sys.argv[1:]):
            DB = sys.argv[1:][i + 1]; i += 2
        else:
            argv.append(a); i += 1
    if len(argv) != 1:
        print("Usage: python3 scripts/apply-migration.py <migration-file> [--org <org>] [--db <db>]",
              file=sys.stderr)
        sys.exit(1)
    with open(argv[0], encoding="utf-8") as f:
        sql = f.read()
    stmts = sql.split(";\n")
    cleaned = []
    for s in stmts:
        # Strip -- comments (full-line and trailing), keep statement text.
        lines = []
        for ln in s.split("\n"):
            if "--" in ln:
                ln = ln[:ln.index("--")]
            lines.append(ln)
        t = "\n".join(lines).strip()
        if t:
            cleaned.append(t)
    # Resolve the database URL from the Platform API (never hardcoded).
    info = turso_platform(f"/v1/organizations/{ORG}/databases/{DB}")
    info = info.get("database", info)
    db_url = "https://" + info["hostname"]
    print(f"Target DB: {ORG}/{DB} at {db_url}")
    print(f"Minting a short-lived DB token for {ORG}/{DB} ...")
    token_resp = turso_platform(f"/v1/organizations/{ORG}/databases/{DB}/auth/tokens", method="POST", body={})
    token = token_resp.get("jwt")
    if not token:
        raise SystemExit(f"Token mint returned no jwt (keys: {sorted(token_resp.keys())})")
    print(f"Applying {len(cleaned)} statements from {argv[0]} ...")
    for i in range(0, len(cleaned), 10):
        data = pipeline(token, db_url, cleaned[i:i + 10])
        for r in data.get("results", []):
            if r.get("type") == "error":
                raise SystemExit(f"Migration failed: {r['error']}")
        print(f"  statements {i + 1}-{min(i + 10, len(cleaned))} OK")
    # Verify: list tables, print names only (no data, no token).
    data = pipeline(token, db_url, ["SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"])
    rows = data["results"][0]["response"]["result"].get("rows", [])
    names = sorted(r[0]["value"] for r in rows)
    print(f"Tables now ({len(names)}): {', '.join(names)}")
    print("Migration complete. Token was used in-process only and is discarded.")


if __name__ == "__main__":
    main()
