#!/bin/sh
# AgentX Social — build the React frontend into public/ (Worker-served).
# Cleans stale hashed chunks AND the old vanilla SPA files (app.js,
# styles.css, ece.js) so no stale asset is ever served again. llms.txt
# and the rest of public/ survive (emptyOutDir is false in vite.config.js).
# Run from the repo root: sh frontend/build.sh
set -e
cd "$(dirname "$0")"
rm -rf ../public/assets ../public/app.js ../public/styles.css ../public/ece.js
npx vite build
echo "--- public/ after build ---"
ls -la ../public/ ../public/assets/
