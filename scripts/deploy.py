#!/usr/bin/env python3
"""Deploy the AgentX Social Worker with wrangler, using the registered
Cloudflare API Token connector (custom.cloudflare-api-token).

The credential is fetched as an `hsurr:` surrogate and passed to
wrangler as CLOUDFLARE_API_TOKEN; the VM proxy swaps the surrogate
for the real token on requests to api.cloudflare.com. The surrogate
and the real token are never printed.

Usage (from the repo root): python3 scripts/deploy.py
"""
import os
import subprocess
import sys

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import dynamic_credential_entry

entry = dynamic_credential_entry("custom.cloudflare-api-token")
surrogate = entry["surrogate"]
env = dict(os.environ)
env["CLOUDFLARE_API_TOKEN"] = surrogate
proc = subprocess.run(
    ["./node_modules/.bin/wrangler", "deploy"],
    env=env, cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
)
sys.exit(proc.returncode)
