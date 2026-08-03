#!/usr/bin/env bash
# Backend app-setup. Run from anywhere: ./server/setup.sh (or: npm run setup)
# Deposits ONLY the generic root orchestrator (setup.sh) into the parent ("root")
# dir. The compose fragments stay in this repo's deploy/ dir — the orchestrator
# references them in place by absolute path, so nothing docker-specific litters
# the root and a pm2-only user gets no compose files at all. Environment-agnostic;
# the environment is chosen later by the root setup.sh.
set -euo pipefail
cd "$(dirname "$0")"          # -> server/ (repo root, whatever it's named)
ROOT=".."

# The orchestrator is the only thing that must live in root (so `./setup.sh`
# works there). It auto-detects this repo and the frontend repo by marker files,
# so the folder names are irrelevant.
cp deploy/setup.sh "$ROOT"/setup.sh
chmod +x "$ROOT"/setup.sh

# If root is a git repo, keep the generated/machine-specific artifacts out of it.
# (Only the orchestrator + the files IT generates ever land here now.)
GI="$ROOT/.gitignore"
if [ -f "$GI" ] && ! grep -q 'deploy generated (setup.sh)' "$GI"; then
	cat >> "$GI" <<'EOF'

# deploy generated (setup.sh) — machine-specific, not source
/setup.sh
/deploy.conf
/.env
/ecosystem.config.js
/Caddyfile
/joust.service
/images/
EOF
fi

echo "✓ root orchestrator deposited: $(cd "$ROOT" && pwd)/setup.sh"
echo "  next: clone the frontend repo beside this one (if not yet), then run"
echo "        ./setup.sh in the root dir. (The frontend's 'npm run setup' is"
echo "        optional now — the orchestrator finds both repos automatically.)"
