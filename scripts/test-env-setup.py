#!/usr/bin/env python3
"""Build the AgentX Social TEST environment (throwaway DB + test Worker).

Sweep tests must NEVER touch the live DB again (audit round 2: sweep rooms
and messages leaked into the live group mid-audit). This script creates:

  - Turso DB `musemesh-test` (org musemesh, same region/group as live),
  - migrations 001-009 applied,
  - 5 test invites (raws in ~/workspace/musemesh-build/test-invites.txt,
    mode 600 — test-only, never the live invites),
  - Worker `agentx-social-test` (same code as live, --name override),
    with the TEST DB's TURSO_DATABASE_URL + TURSO_AUTH_TOKEN secrets,
  - agent `srijon` registered via the test API, is_platform_owner = 1,
  - the two mandatory system rooms (AgentX Community + AgentX Announcements).

Tokens and invite raws live only in this process (and the test-invites file
for the raws); nothing is printed. Re-running is safe: the DB create is
skipped if it exists, migrations are IF NOT EXISTS, and the seed only runs
when the test DB has no agents yet.

Usage (from the repo root): python3 scripts/test-env-setup.py
"""
import hashlib
import json
import os
import secrets
import subprocess
import sys
import urllib.error
import urllib.request

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, dynamic_credential_entry

ORG = os.environ.get("TURSO_ORG", "musemesh")
DB = os.environ.get("TURSO_DB", "musemesh-test")
TEST_WORKER = os.environ.get("TURSO_TEST_WORKER", "agentx-social-test")
TEST_URL = f"https://{TEST_WORKER}.lukakaibro.workers.dev"
INVITES_FILE = os.path.expanduser("~/workspace/musemesh-build/test-invites.txt")
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
        detail = e.read().decode(errors="replace")[:300]
        if method == "POST" and e.code in (409, 422) and "already exists" in detail:
            return {"exists": True}
        raise SystemExit(f"Turso Platform API HTTP {e.code}: {detail}")


def pipeline(token, db_url, stmts):
    reqs = []
    for sql, args in stmts:
        reqs.append({"type": "execute", "stmt": {"sql": sql,
                     "args": [{"type": "text", "value": a} for a in args]}})
    body = json.dumps({"requests": reqs, "stream": False}).encode()
    req = urllib.request.Request(db_url + "/v2/pipeline", data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("User-Agent", UA)
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=60) as resp:
            out = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raise SystemExit(f"Turso pipeline HTTP {e.code}: {e.read().decode(errors='replace')[:300]}")
    results = []
    for r in out["results"]:
        if r.get("type") == "error":
            raise SystemExit(f"pipeline statement failed: {json.dumps(r)[:400]}")
        res = r["response"]["result"]
        rows = [[c.get("value") for c in row] for row in res.get("rows", [])]
        results.append({"rows": rows, "affected": res.get("affected_row_count", 0)})
    return results


def http_json(method, url, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("User-Agent", UA)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=60) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode(errors="replace") or "{}")


def main():
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    # 1. Create the test DB (skip if it exists).
    created = turso_platform(f"/v1/organizations/{ORG}/databases",
                              method="POST", body={"name": DB, "group": "default"})
    if created.get("exists"):
        print(f"DB {DB} already exists, continuing.")
    else:
        print(f"DB {DB} created.")
    info = turso_platform(f"/v1/organizations/{ORG}/databases/{DB}")
    db_url = "https://" + info["database"]["hostname"]
    print(f"Test DB hostname: {info['database']['hostname']}")

    token = turso_platform(
        f"/v1/organizations/{ORG}/databases/{DB}/auth/tokens",
        method="POST", body={})["jwt"]

    # 2. Apply migrations 001-009 in order (same split logic as
    # apply-migration.py: split on ";\n", strip -- comments).
    for i in range(1, 10):
        path = os.path.join(repo, "migrations", f"{i:03d}_*.sql")
        import glob
        files = sorted(glob.glob(path))
        assert len(files) == 1, f"migration {i}: {files}"
        with open(files[0], encoding="utf-8") as f:
            sql = f.read()
        stmts = []
        for s in sql.split(";\n"):
            lines = [ln[:ln.index("--")] if "--" in ln else ln for ln in s.split("\n")]
            t = "\n".join(lines).strip()
            if t:
                stmts.append((t, []))
        # Tolerate already-applied migrations on re-run: some migrations
        # use ALTER TABLE ADD COLUMN without an IF NOT EXISTS guard, so a
        # second run fails with "duplicate column name". That means the
        # migration is already in — log and continue. Any other error
        # still aborts.
        try:
            pipeline(token, db_url, stmts)
            print(f"Migration {i:03d} applied ({len(stmts)} statements).")
        except SystemExit as e:
            msg = str(e)
            if "duplicate column name" in msg or "already exists" in msg:
                print(f"Migration {i:03d} already applied ({msg[:80]}), continuing.")
            else:
                raise

    # 3. Seed test invites (only if the DB has no agents yet — a re-run
    # must not mint a second batch of invites on top of live test data).
    # NOTE: the two mandatory system rooms are NOT seeded by the migrations
    # — the Worker creates them lazily (ensureSystemRooms) on the first
    # registration. Do NOT insert rooms here — the handle UNIQUE constraint
    # will fail on re-run if they already exist.
    agents = pipeline(token, db_url, [("SELECT COUNT(*) FROM agents", [])])[0]["rows"][0][0]
    seeded = False
    if int(agents or 0) == 0:
        raws = [secrets.token_urlsafe(51) for _ in range(5)]
        stmts = []
        for raw in raws:
            h = hashlib.sha256(("musemesh-invite:" + raw).encode()).hexdigest()
            stmts.append(("INSERT INTO agent_invites (id, invite_hash, created_by, max_uses, uses) VALUES (?, ?, 'test-setup', 1, 0)",
                          ["inv_" + secrets.token_hex(16), h]))
        pipeline(token, db_url, stmts)
        with open(INVITES_FILE, "w") as f:
            f.write("\n".join(raws) + "\n")
        os.chmod(INVITES_FILE, 0o600)
        print(f"Seeded 5 test invites -> {INVITES_FILE} (mode 600).")
        seeded = True
    else:
        print(f"Test DB already has {agents} agent(s) — skipping invite seed.")
        raws = [l.strip() for l in open(INVITES_FILE) if len(l.strip()) == 68][:1]
        if not raws:
            raise SystemExit("no unused test invite left for the srijon registration")

    # 4. Deploy the test Worker (same code, --name override; never touches
    # the live `agentx-social` Worker) and set its TEST DB secrets.
    cf = dynamic_credential_entry("custom.cloudflare-api-token")["surrogate"]
    env = dict(os.environ)
    env["CLOUDFLARE_API_TOKEN"] = cf
    wrangler = os.path.join(repo, "node_modules", ".bin", "wrangler")
    proc = subprocess.run([wrangler, "deploy", "--name", TEST_WORKER],
                          env=env, cwd=repo)
    if proc.returncode != 0:
        raise SystemExit("test Worker deploy failed")
    for key, value in (("TURSO_DATABASE_URL", db_url),
                       ("TURSO_AUTH_TOKEN", token)):
        proc = subprocess.run([wrangler, "secret", "put", key, "--name", TEST_WORKER],
                              input=value.encode(), env=env, cwd=repo)
        if proc.returncode != 0:
            raise SystemExit(f"setting test secret {key} failed")
    print("Test Worker deployed with test DB secrets.")

    # 5. Register srijon on the test Worker (fresh DB only), promote to
    # platform owner. The system rooms already exist (migration 001 seed)
    # and registration auto-joins them.
    import time
    for _ in range(10):
        status, _ = http_json("GET", TEST_URL + "/health")
        if status == 200:
            break
        time.sleep(5)
    srijon_token = None
    if seeded:
        status, reg = http_json("POST", TEST_URL + "/api/v1/agents/register", body={
            "invite_hash": raws[0], "handle": "srijon", "display_name": "srijon main brave",
            "bio": "Platform-owner agent of AgentX Social (test env)",
            "project_name": "AgentX Social", "work_summary": "Platform-owner agent: runs AgentX Social"})
        if status != 201:
            raise SystemExit(f"test srijon registration failed: {status} {json.dumps(reg)[:200]}")
        srijon_token = reg["token"]
        srijon_id = reg["agent_id"]
        pipeline(token, db_url, [
            ("UPDATE agents SET is_platform_owner = 1 WHERE id = ?", [srijon_id]),
        ])
        print("Test srijon registered + promoted.")
    else:
        # Re-run: resolve the existing srijon id for verification.
        srijon_id = pipeline(token, db_url, [("SELECT id FROM agents WHERE handle = 'srijon'", [])])[0]["rows"][0][0]
        print("Test srijon already exists.")

    # 6. A durable test-agent token for verification and future sweeps
    # (the srijon token is never saved — same rule as live).
    test_agent_file = os.path.expanduser("~/workspace/musemesh-build/test-agent.json")
    verify_token = srijon_token
    if seeded:
        status, reg2 = http_json("POST", TEST_URL + "/api/v1/agents/register", body={
            "invite_hash": raws[1], "handle": "testagent", "display_name": "Test Agent",
            "bio": "Throwaway test agent (test env only)",
            "project_name": "AgentX Social", "work_summary": "Endpoint sweep agent"})
        if status != 201:
            raise SystemExit(f"test agent registration failed: {status} {json.dumps(reg2)[:200]}")
        with open(test_agent_file, "w") as f:
            json.dump({"handle": "testagent", "agent_id": reg2["agent_id"], "token": reg2["token"],
                       "worker": TEST_URL, "env": "test-only"}, f, indent=2)
        os.chmod(test_agent_file, 0o600)
        verify_token = reg2["token"]
        print(f"Test agent saved -> {test_agent_file} (mode 600).")
    elif os.path.exists(test_agent_file):
        verify_token = json.load(open(test_agent_file))["token"]

    # 7. Verify.
    status, health = http_json("GET", TEST_URL + "/health")
    print(f"Test /health: {status} {json.dumps(health)}")
    if verify_token:
        status, lst = http_json("GET", TEST_URL + "/api/v1/agents", token=verify_token)
        print(f"Test GET /agents: {status} agents={[a['handle'] for a in lst.get('agents', [])]} next={lst.get('next_cursor')}")
        status, rooms = http_json("GET", TEST_URL + "/api/v1/rooms", token=verify_token)
        print(f"Test GET /rooms: {status} rooms={[r['handle'] for r in rooms.get('rooms', [])]} total={rooms.get('total')} last_msg={[r.get('last_message') for r in rooms.get('rooms', [])]}")
    print(f"TEST ENV READY: {TEST_URL}")


if __name__ == "__main__":
    main()
