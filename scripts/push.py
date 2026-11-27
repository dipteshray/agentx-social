#!/usr/bin/env python3
"""Push the AgentX Social working tree to the private GitHub repo via the
GitHub Contents API (api.github.com), using the registered
custom.github-classic connector surrogate. The surrogate is never printed.

gh CLI is not logged in on this VM and git-over-HTTPS cannot use the
surrogate (github.com is not a registered host for this connector), so
the Contents API is the push route. One commit per file (the API's unit);
all files are small text files, well under the 1 MB per-file limit.

Usage (from the repo root): python3 scripts/push.py [--message "..."]
Excluded: node_modules, .wrangler, dist, __pycache__, .git.
"""
import base64
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import dynamic_credential_entry

OWNER = "dipteshray"
REPO = "agentx-social"
BRANCH = "main"
EXCLUDE_DIRS = {"node_modules", ".wrangler", "dist", "__pycache__", ".git"}
UA = "Muse/1.0 (custom-connector; +https://muse.ai)"


SURROGATE = None


def gh(path, method="GET", body=None):
    url = "https://api.github.com" + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", UA)
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    # Attach the surrogate as a Bearer token; the VM proxy swaps it for the
    # real GitHub token on requests to api.github.com.
    req.add_header("Authorization", "Bearer " + SURROGATE)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:500]
        if method == "GET" and e.code == 404:
            return None
        raise SystemExit(f"GitHub API {method} {path} HTTP {e.code}: {detail}")


def main():
    global SURROGATE
    SURROGATE = dynamic_credential_entry("custom.github-classic")["surrogate"]
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    message = "AgentX Social v0.8.0 — rebrand + platform-owner agent srijon"
    if "--message" in sys.argv:
        message = sys.argv[sys.argv.index("--message") + 1]
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        for fn in sorted(filenames):
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            files.append((rel, full))
    changed = skipped = 0
    for rel, full in files:
        with open(full, "rb") as f:
            content = f.read()
        current = gh(f"/repos/{OWNER}/{REPO}/contents/{rel}?ref={BRANCH}")
        new_sha_blob = None
        if current is not None:
            old = base64.b64decode(current["content"])
            if old == content:
                skipped += 1
                continue
            new_sha_blob = current["sha"]
        body = {"message": message, "content": base64.b64encode(content).decode(), "branch": BRANCH}
        if new_sha_blob:
            body["sha"] = new_sha_blob
        res = gh(f"/repos/{OWNER}/{REPO}/contents/{rel}", method="PUT", body=body)
        print(("updated " if new_sha_blob else "created ") + rel + " -> " + res["commit"]["sha"][:8])
        changed += 1
    print(f"Done: {changed} files pushed, {skipped} unchanged.")
    # Verify the tree matches: list the repo root via the API.
    tree = gh(f"/repos/{OWNER}/{REPO}/git/trees/{BRANCH}?recursive=1")
    print(f"Repo tree now has {len(tree['tree'])} entries.")


if __name__ == "__main__":
    main()
