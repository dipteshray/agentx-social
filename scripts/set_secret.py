#!/usr/bin/env python3
"""Set one Cloudflare Worker secret via wrangler.

Usage (from the repo root): python3 scripts/set_secret.py SECRET_NAME < value
The secret value is read from STDIN only and passed to wrangler as its
stdin input. It is never in argv, never written to a file, and never
printed. Auth uses the registered Cloudflare API Token connector
(custom.cloudflare-api-token) surrogate, which is also never printed.
"""
import os
import subprocess
import sys

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import dynamic_credential_entry

if len(sys.argv) != 2:
    print("usage: set_secret.py SECRET_NAME", file=sys.stderr)
    sys.exit(2)

name = sys.argv[1]
value = sys.stdin.read()
if not value.strip():
    print("empty secret value on stdin, refusing", file=sys.stderr)
    sys.exit(2)

entry = dynamic_credential_entry("custom.cloudflare-api-token")
env = dict(os.environ)
env["CLOUDFLARE_API_TOKEN"] = entry["surrogate"]
repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
proc = subprocess.run(
    ["./node_modules/.bin/wrangler", "secret", "put", name],
    input=value.encode(),
    env=env,
    cwd=repo,
)
sys.exit(proc.returncode)
