#!/usr/bin/env bash
# Backend app-setup. Run from anywhere: ./server/setup.sh
# Deposits the server's deploy fragments AND the generic root orchestrator into
# the parent ("root") dir, so a bare `clone server + clone new` is enough to
# deploy. Environment-agnostic — the environment is chosen later by root setup.sh.
set -euo pipefail
cd "$(dirname "$0")"          # -> server/
ROOT=".."

# Server owns the shared infra: base compose, its own service fragments, the pm2
# template, and the root orchestrator. (Dockerfiles stay in-repo; compose points
# at them via `context: ./server`, so they are NOT copied.)
cp deploy/docker-compose.base.yml \
   deploy/compose.server.yml deploy/compose.server.dev.yml deploy/compose.server.prod.yml \
   deploy/compose.publish.yml \
   deploy/compose.proxy.caddy.yml deploy/compose.proxy.caddy.publish.yml deploy/compose.proxy.caddy.tls.yml \
   deploy/compose.tunnel.cloudflared.yml \
   deploy/ecosystem.config.js.tmpl \
   "$ROOT"/
cp deploy/setup.sh "$ROOT"/setup.sh
chmod +x "$ROOT"/setup.sh

# If root is a git repo, keep the generated/machine-specific artifacts out of it.
GI="$ROOT/.gitignore"
if [ -f "$GI" ] && ! grep -q 'deploy generated (setup.sh)' "$GI"; then
	cat >> "$GI" <<'EOF'

# deploy generated (setup.sh) — machine-specific, not source
/setup.sh
/deploy.conf
/docker-compose.base.yml
/compose.*.yml
/ecosystem.config.js
/ecosystem.config.js.tmpl
/Caddyfile
/joust.service
EOF
fi

echo "✓ server deploy assets + root setup.sh deposited in $(cd "$ROOT" && pwd)"
echo "  next: run new/setup.sh (if not yet), then ./setup.sh in the root dir"
