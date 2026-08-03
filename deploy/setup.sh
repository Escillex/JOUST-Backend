#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# JOUST deployment orchestrator.  Deposited into the repo root by
# `server/setup.sh`; run it from there:  ./setup.sh
#
# It is intentionally GENERIC — it knows nothing about "server" vs "new"
# specifically; it drives whatever compose.*.yml fragments the two app setups
# left in this directory. A friendly interactive script (no CLI flags): it asks
# a few questions, writes deploy.conf + .env, and brings the stack up.
#
# One required choice — STACK (docker|pm2) — plus optional, composable layers:
#   MODE (dev|prod) · reverse proxy (none|caddy) · tunnel (none|cloudflared) ·
#   TLS (Let's Encrypt) · systemd boot-service. The old local/cloudflared/vps
#   "modes" are just compositions of these answers.
# ─────────────────────────────────────────────────────────────────────────────
set -eu   # NB: no `pipefail` — early-exit pipes (grep -m1, awk … exit) mustn't fail the run
cd "$(dirname "$0")"
ROOT="$PWD"

c_bold=$'\033[1m'; c_dim=$'\033[2m'; c_grn=$'\033[32m'; c_red=$'\033[31m'; c_rst=$'\033[0m'
say()    { printf '%s\n' "$*"; }
# NB: named `banner`, NOT `head` — a `head()` function shadows the coreutil, so
# `head -c`/`head -n` in pipelines silently call this printer instead (that bug
# once wrote a bold "-1" control sequence into the cloudflared config).
banner() { printf '\n%s%s%s\n' "$c_bold" "$*" "$c_rst"; }
die()  { printf '%s%s%s\n' "$c_red" "$*" "$c_rst" >&2; exit 1; }
warn() { printf '%s%s%s\n' "$c_red" "$*" "$c_rst" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }
# N random bytes as base64, no newline — openssl if present, else /dev/urandom.
randb64() {
	if have openssl; then openssl rand -base64 "$1" | tr -d '\n'
	elif have base64; then head -c "$1" /dev/urandom | base64 | tr -d '\n'
	else od -An -tx1 -N "$1" /dev/urandom | tr -d ' \n'; fi
}

# ── locate the two app repos ─────────────────────────────────────────────────
# The compose fragments live INSIDE each repo's deploy/ dir (not copied here), so
# a bare "clone backend + clone frontend side by side" is enough. Folder names are
# arbitrary — a GitHub clone is JOUST-Backend / JOUST-Frontend, a dev checkout is
# server / new — so we identify each repo by a marker file unique to it rather
# than by name. All host paths handed to compose are ABSOLUTE (see .env below),
# which is what lets the fragments sit outside this deploy root.
find_repo() {          # $1 = marker file (relative to a candidate repo dir)
	local d
	for d in */; do [ -f "$d$1" ] && { printf '%s' "$ROOT/${d%/}"; return 0; }; done
	return 1
}
JOUST_SERVER_DIR=$(find_repo deploy/compose.server.yml) \
	|| die "backend repo not found beside this dir (looked for */deploy/compose.server.yml). Clone it here and run its 'npm run setup'."
JOUST_FRONTEND_DIR=$(find_repo deploy/compose.new.yml) \
	|| die "frontend repo not found beside this dir (looked for */deploy/compose.new.yml). Clone it here and run its 'npm run setup'."
JOUST_IMAGES_DIR="$ROOT/images"
mkdir -p "$JOUST_IMAGES_DIR"   # uploads bind-mount target; persists across restarts
[ -f "$JOUST_SERVER_DIR/deploy/docker-compose.base.yml" ] \
	|| die "$JOUST_SERVER_DIR/deploy/docker-compose.base.yml missing — is the backend repo intact?"

# ── prompt helpers ───────────────────────────────────────────────────────────
# ask VAR "Question" "default"
ask() {
	local __v=$1 q=$2 def=${3:-} ans
	read -r -p "  $q${def:+ [$def]}: " ans || true
	printf -v "$__v" '%s' "${ans:-$def}"
}
# choose VAR "Question" default opt1 opt2 …
choose() {
	local __v=$1 q=$2 def=$3; shift 3
	local opts=("$@") ans
	say "  $q"
	local i=1; for o in "${opts[@]}"; do printf '    %d) %s%s\n' "$i" "$o" "$([ "$o" = "$def" ] && echo '  (default)')"; i=$((i+1)); done
	while :; do
		read -r -p "  choice [$def]: " ans || true
		[ -z "$ans" ] && { printf -v "$__v" '%s' "$def"; return; }
		if [[ "$ans" =~ ^[0-9]+$ ]] && [ "$ans" -ge 1 ] && [ "$ans" -le "${#opts[@]}" ]; then
			printf -v "$__v" '%s' "${opts[$((ans-1))]}"; return
		fi
		for o in "${opts[@]}"; do [ "$ans" = "$o" ] && { printf -v "$__v" '%s' "$o"; return; }; done
		say "    ${c_red}invalid${c_rst}"
	done
}

# read a value from an existing .env (grep -m1 → no SIGPIPE; || true → set -e safe)
existing_env() { [ -f .env ] || return 0; grep -m1 -E "^$1=" .env | cut -d= -f2- | tr -d '"' || true; }

banner "JOUST deploy setup"
choose STACK "Stack — how do the apps run?" docker docker pm2
choose MODE  "Mode"                          prod   prod   dev
ask    HOST  "Public host (blank = localhost, for LAN/local use)" "localhost"
ask    FRONTEND_PORT "Frontend port" "3000"
ask    BACKEND_PORT  "Backend port"  "4000"

choose PROXY  "Reverse proxy in front of the apps?" none none caddy
choose TUNNEL "Expose via a tunnel?"                 none none cloudflared

SERVICE=off
PROXY_HTTP_PORT=80

# TLS only makes sense NOT behind a tunnel (the tunnel edge already terminates it).
TLS=off
[ "$TUNNEL" = none ] && choose TLS "Serve real HTTPS via Let's Encrypt? (needs a public domain + ports 80/443)" off off on

# A tunnel OR TLS needs a proxy to split /socket.io/ from the frontend — auto-enable caddy.
if { [ "$TUNNEL" != none ] || [ "$TLS" = on ]; } && [ "$PROXY" = none ]; then
	PROXY=caddy; say "  ${c_dim}(exposure needs a proxy — enabling caddy)${c_rst}"
fi

# Runtime: Caddy/cloudflared as containers, or the machine's own host install
# (coexists with an existing host Caddy). Only relevant when a proxy is in play.
RUNTIME=containerized
[ "$PROXY" = caddy ] && choose RUNTIME "Run Caddy/cloudflared as containers, or use the host's?" containerized containerized host

# A public hostname/domain is required for a tunnel or TLS.
if [ "$TUNNEL" != none ] || [ "$TLS" = on ]; then
	[ "$HOST" = localhost ] && ask HOST "Public hostname/domain (e.g. joust.example.com)" ""
	if [ -z "$HOST" ] || [ "$HOST" = localhost ]; then die "public exposure (tunnel/TLS) needs a real hostname."; fi
fi

# Tunnel credentials: a CONTAINER tunnel uses a token; a HOST tunnel is
# locally-managed (a named tunnel you've already `cloudflared tunnel create`d).
CF_TUNNEL_TOKEN=$(existing_env CF_TUNNEL_TOKEN)
TUNNEL_NAME=$(existing_env TUNNEL_NAME)
if [ "$TUNNEL" = cloudflared ]; then
	if [ "$RUNTIME" = containerized ]; then
		ask CF_TUNNEL_TOKEN "cloudflared tunnel token (from: cloudflared tunnel token <name>)" "${CF_TUNNEL_TOKEN:-}"
		[ -z "$CF_TUNNEL_TOKEN" ] && die "a containerized cloudflared tunnel needs a token."
	else
		ask TUNNEL_NAME "cloudflared tunnel name (you've run: cloudflared tunnel create <name>)" "${TUNNEL_NAME:-joust}"
	fi
fi

# TLS account email.
ACME_EMAIL=$(existing_env ACME_EMAIL)
[ "$TLS" = on ] && ask ACME_EMAIL "ACME / Let's Encrypt account email" "${ACME_EMAIL:-}"

# Custom HTTP port only for a local proxy that publishes it (not tunnel, not tls).
[ "$PROXY" != none ] && [ "$TUNNEL" = none ] && [ "$TLS" != on ] && ask PROXY_HTTP_PORT "Proxy HTTP port" "80"

# Boot-persistence via systemd — only offered where systemd is actually running.
if [ -d /run/systemd/system ]; then
	choose SERVICE "Install a systemd service so the stack starts on boot?" off off on
else
	SERVICE=off
fi

# ── dependency guards (fail early with a clear message) ──────────────────────
if [ "$STACK" = docker ]; then
	have docker || die "docker not found — install Docker, or re-run and choose the pm2 stack."
	docker compose version >/dev/null 2>&1 || die "the 'docker compose' plugin is missing — install it (e.g. 'pacman -S docker-compose')."
else
	have node || die "node not found — the pm2 stack builds and runs the apps on the host."
	have npm  || die "npm not found — needed to build the apps for the pm2 stack."
	have pm2  || die "pm2 not found — install it (npm i -g pm2), or choose the docker stack."
fi
# Host runtime drives the machine's own Caddy/cloudflared, so those must exist.
if [ "$RUNTIME" = host ]; then
	have caddy || die "host runtime needs 'caddy' installed on this machine (or pick containerized)."
	[ "$TUNNEL" = cloudflared ] && { have cloudflared || die "a host cloudflared tunnel needs 'cloudflared' installed."; }
elif [ "$TUNNEL" = cloudflared ] && ! have cloudflared; then
	# containerized tunnel: cloudflared only needed once on the host to mint the token
	warn "  note: 'cloudflared' isn't on PATH — you'll need it once to run 'cloudflared tunnel token <name>'."
fi

# ── preserve or generate secrets ─────────────────────────────────────────────
JWT_SECRET=$(existing_env JWT_SECRET)
[ -n "$JWT_SECRET" ] || JWT_SECRET=$(randb64 48)
PG_PW=$(existing_env POSTGRES_PASSWORD)
if [ -z "$PG_PW" ]; then PG_PW=$(randb64 32 | tr -dc 'A-Za-z0-9'); PG_PW=${PG_PW:0:24}; fi
ADMIN_PW=$(existing_env ADMIN_PASSWORD)
if [ -z "$ADMIN_PW" ]; then
	rnd=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
	ask ADMIN_PW "Initial admin password (seeded on a fresh DB)" "change-me-$rnd"
fi

HOST_IP=${HOST:-localhost}; [ -z "$HOST_IP" ] && HOST_IP=localhost
# NODE_ENV=production whenever the instance is publicly exposed (tunnel/tls) — it
# gates the Secure cookie + enforced CORS — even if MODE=dev (hot reload). This is
# the same rationale as the dev-on-tunnel instance (deploy.md §9.6).
if [ "$MODE" = prod ] || [ "$TUNNEL" != none ] || [ "$TLS" != off ]; then NODE_ENV=production; else NODE_ENV=development; fi

# Host runtime publishes the app containers to loopback only (the host Caddy
# reaches them there); containerized/none publish on all interfaces.
if [ "$RUNTIME" = host ]; then BIND_ADDR=127.0.0.1; else BIND_ADDR=0.0.0.0; fi

# Browser origin + socket URL depend on how the apps are exposed.
if [ "$TUNNEL" != none ] || [ "$TLS" != off ]; then
	# public HTTPS (tunnel edge or real cert): same-origin on the public host
	ORIGINS="https://$HOST_IP"
	SOCKET_URL=""     # same-origin; Caddy routes /socket.io/ to the backend
elif [ "$PROXY" = none ]; then
	# apps published directly: browser hits the frontend port, socket the backend port
	if [ "$HOST_IP" = localhost ]; then ORIGINS="http://localhost:$FRONTEND_PORT"
	else ORIGINS="http://$HOST_IP:$FRONTEND_PORT,http://localhost:$FRONTEND_PORT"; fi
	SOCKET_URL="http://$HOST_IP:$BACKEND_PORT"
else
	# behind a local proxy: same-origin on the proxy's http port
	psfx=""; [ "$PROXY_HTTP_PORT" != 80 ] && psfx=":$PROXY_HTTP_PORT"
	if [ "$HOST_IP" = localhost ]; then ORIGINS="http://localhost$psfx"
	else ORIGINS="http://$HOST_IP$psfx,http://localhost$psfx"; fi
	SOCKET_URL=""
fi

# ── compose file list (COMPOSE_FILE lets `docker compose` auto-merge them) ────
# Fragments are referenced IN PLACE by absolute path inside each repo's deploy/
# dir — nothing is copied into the deploy root. `docker compose` resolves each -f
# relative to the working dir (root), and every host path inside the fragments is
# an absolute ${JOUST_*_DIR} var, so the split location is invisible to the build.
# All shared/base/proxy/tunnel fragments live in the backend repo; only the two
# compose.new.* fragments live in the frontend repo.
compose_list() {
	local s="$JOUST_SERVER_DIR/deploy" n="$JOUST_FRONTEND_DIR/deploy"
	local f="$s/docker-compose.base.yml:$s/compose.server.yml:$s/compose.server.$MODE.yml:$n/compose.new.yml:$n/compose.new.$MODE.yml"
	if [ "$PROXY" = none ] || [ "$RUNTIME" = host ]; then
		# apps publish their ports: all-interfaces for `none`, loopback for host
		# runtime (a host Caddy proxies to them). No containerized proxy/tunnel.
		f="$f:$s/compose.publish.yml"
	else
		f="$f:$s/compose.proxy.$PROXY.yml"                # a container proxy fronts them
		# publish the proxy's host port(s) only when a tunnel ISN'T fronting it:
		# tls → 80+443 (real cert), else → 80 only
		if [ "$TUNNEL" = none ]; then
			if [ "$TLS" = on ]; then f="$f:$s/compose.proxy.$PROXY.tls.yml"
			else f="$f:$s/compose.proxy.$PROXY.publish.yml"; fi
		fi
	fi
	# containerized tunnel only; a host tunnel runs outside compose
	[ "$TUNNEL" != none ] && [ "$RUNTIME" != host ] && f="$f:$s/compose.tunnel.$TUNNEL.yml"
	printf '%s' "$f"
}

# Rendered into ./Caddyfile when PROXY=caddy. Container always listens on :80
# (the host maps PROXY_HTTP_PORT->80). /socket.io/ must go straight to the
# backend — Next never forwards it. Phase 4 (TLS) swaps `:80` for `$HOST` so
# Caddy provisions a real cert.
render_caddyfile() {
	if [ "$TLS" = on ]; then
		# Real HTTPS. A bare `$HOST { }` block makes Caddy auto-provision a Let's
		# Encrypt cert and redirect HTTP→HTTPS (verified against caddyserver.com
		# docs). caddy_data volume persists the cert. HTTP/3 on 443/udp.
		cat > Caddyfile <<CADDY
# Generated by setup.sh — edit via setup.sh, not here.
{
	email $ACME_EMAIL
	# FIRST real deploy: uncomment to issue from Let's Encrypt STAGING (avoids the
	# prod rate limit if DNS/ports are misconfigured). Confirm a cert is obtained,
	# then re-comment and re-run for the trusted prod cert:
	# acme_ca https://acme-staging-v02.api.letsencrypt.org/directory
}
$HOST_IP {
	encode zstd gzip
	# /socket.io/ must reach the backend directly — Next never forwards it.
	handle /socket.io/* {
		reverse_proxy server:4000
	}
	handle {
		reverse_proxy new:3000
	}
	# HSTS — enable ONLY after confirming a real cert serves, or you can lock
	# browsers onto broken HTTPS:
	# header Strict-Transport-Security "max-age=31536000; includeSubDomains"
}
CADDY
	else
		# Plain HTTP on :80 (local proxy, or behind a tunnel that terminates TLS).
		cat > Caddyfile <<CADDY
# Generated by setup.sh — edit via setup.sh, not here.
:80 {
	encode zstd gzip
	handle /socket.io/* {
		reverse_proxy server:4000
	}
	handle {
		reverse_proxy new:3000
	}
}
CADDY
	fi
}

# systemd unit that brings the docker stack up on boot (reads COMPOSE_FILE from
# .env in WorkingDirectory). Rendered when SERVICE=on on a systemd host.
render_service() {
	cat > joust.service <<UNIT
[Unit]
Description=JOUST stack (docker compose)
Requires=docker.service
After=docker.service network-online.target
[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$ROOT
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
[Install]
WantedBy=multi-user.target
UNIT
}

# HOST runtime: write a host Caddy vhost that fronts the loopback-published apps.
# Host-matched block → coexists with any other vhosts already on the box. Needs
# sudo for the /etc write + reload. (Global options like the LE-staging toggle
# live in the main Caddyfile, not this snippet.)
render_host_caddy() {
	local site
	if [ "$TLS" = on ]; then site="$HOST_IP"; else site="http://$HOST_IP"; fi
	sudo tee /etc/caddy/conf.d/joust.caddy >/dev/null <<CADDY
# Generated by setup.sh — JOUST (host runtime). Apps run in Docker on loopback.
# $([ "$TLS" = on ] && echo 'Bare host → Caddy auto-provisions a real cert.' || echo 'Plain HTTP (behind a tunnel, or local).')
$site {
	encode zstd gzip
	handle /socket.io/* {
		reverse_proxy 127.0.0.1:$BACKEND_PORT
	}
	handle {
		reverse_proxy 127.0.0.1:$FRONTEND_PORT
	}
}
CADDY
	sudo caddy validate --config /etc/caddy/Caddyfile
	sudo systemctl reload caddy
	say "  wrote /etc/caddy/conf.d/joust.caddy + reloaded caddy"
}

# HOST runtime + cloudflared: write a locally-managed tunnel config to a DISTINCT
# path (never clobbers another cloudflared instance's config.yml) and print how to
# run it. Requires a tunnel already created (`cloudflared tunnel create <name>`).
render_host_cloudflared() {
	local cfdir="$HOME/.cloudflared" cfg="$HOME/.cloudflared/joust-deploy.yml" id="" cred
	have cloudflared || die "host tunnel needs 'cloudflared' on PATH to resolve '$TUNNEL_NAME'."
	# Resolve name → UUID from the tunnel LIST by exact NAME match. NOT via
	# `tunnel info`: that command can echo the DEFAULT config.yml's tunnel (the
	# dev one, not this named tunnel) and its table may carry ANSI colour codes —
	# grabbing that once wrote a control-char "-1" into this file and cloudflared
	# refused it ("yaml: control characters are not allowed"). `tr` strips any
	# stray bytes; the regex then insists on a real UUID before we write anything.
	id=$(cloudflared tunnel list 2>/dev/null | awk -v n="$TUNNEL_NAME" '$2==n {print $1; exit}' | tr -dc 'a-fA-F0-9-')
	printf '%s' "$id" | grep -qiE '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' \
		|| die "couldn't resolve tunnel '$TUNNEL_NAME' to a UUID — create it first: cloudflared tunnel create $TUNNEL_NAME"
	cred="$cfdir/$id.json"
	[ -f "$cred" ] || die "tunnel credentials $cred not found — was '$TUNNEL_NAME' created on this machine? (cloudflared tunnel create $TUNNEL_NAME)"
	cat > "$cfg" <<YAML
# Generated by setup.sh — JOUST host tunnel. Separate from config.yml so it never
# clobbers another cloudflared instance on this box.
tunnel: $id
credentials-file: $cred
ingress:
  - hostname: $HOST_IP
    service: http://localhost:80
  - service: http_status:404
YAML
	say "  wrote $cfg (tunnel $TUNNEL_NAME=$id → $HOST_IP)"
	say "  run it: ${c_bold}cloudflared --config $cfg tunnel run $TUNNEL_NAME${c_rst}"
	[ "$SERVICE" = on ] && say "  or as a service: ${c_bold}sudo cloudflared --config $cfg service install${c_rst}"
}

# ── write deploy.conf (human-readable record of the choices) ─────────────────
cat > deploy.conf <<CONF
# Generated by setup.sh — re-run setup.sh to change. Not secrets (those are .env).
STACK=$STACK
MODE=$MODE
PROXY=$PROXY
RUNTIME=$RUNTIME
TUNNEL=$TUNNEL
TLS=$TLS
SERVICE=$SERVICE
HOST=$HOST_IP
FRONTEND_PORT=$FRONTEND_PORT
BACKEND_PORT=$BACKEND_PORT
PROXY_HTTP_PORT=$PROXY_HTTP_PORT
CONF

# ── write .env (read by docker compose for ${VAR} substitution) ──────────────
write_env() {
	cat > .env <<ENV
# Generated by setup.sh. Secrets live here (gitignored). Edit via setup.sh.
COMPOSE_PROJECT_NAME=joust
COMPOSE_FILE=$(compose_list)

# Absolute paths to the two app repos + the uploads dir. The compose fragments
# live inside the repos and reference these, so build contexts / volume mounts
# resolve correctly no matter what the repo folders are named or where they sit.
JOUST_SERVER_DIR=$JOUST_SERVER_DIR
JOUST_FRONTEND_DIR=$JOUST_FRONTEND_DIR
JOUST_IMAGES_DIR=$JOUST_IMAGES_DIR
JOUST_ROOT_DIR=$ROOT

UID=$(id -u)
GID=$(id -g)

POSTGRES_USER=joust
POSTGRES_PASSWORD=$PG_PW
POSTGRES_DB=joust
DB_PORT=5433

JWT_SECRET="$JWT_SECRET"
ADMIN_PASSWORD="$ADMIN_PW"
CF_TUNNEL_TOKEN="$CF_TUNNEL_TOKEN"
TUNNEL_NAME=$TUNNEL_NAME
NODE_ENV=$NODE_ENV

BIND_ADDR=$BIND_ADDR
FRONTEND_PORT=$FRONTEND_PORT
BACKEND_PORT=$BACKEND_PORT
PROXY_HTTP_PORT=$PROXY_HTTP_PORT
HOST_IP=$HOST_IP

ALLOWED_ORIGINS=$ORIGINS
SOCKET_ALLOWED_ORIGINS=$ORIGINS
NEXT_PUBLIC_API_URL=/api/backend
NEXT_PUBLIC_SOCKET_URL=$SOCKET_URL
EXTRA_DEV_ORIGINS=$HOST_IP
ACME_EMAIL=$ACME_EMAIL
ENV
	chmod 600 .env
}

# Reconcile the Postgres role password with .env. Postgres sets a role's password
# ONLY at first init of the pgdata volume — so if that named volume survives from
# an earlier run, or from an earlier .env with a different secret (.env is
# gitignored, so a fresh clone regenerates every secret), the server can't auth
# and crash-loops on Prisma "P1000: authentication failed". We resync idempotently
# over Postgres's LOCAL trust socket (no password needed): a fresh volume makes it
# a harmless no-op, a stale volume gets fixed. PG_PW is alphanumeric, so it is safe
# inside the single-quoted SQL literal.
sync_db_password() {
	printf '  syncing db credentials'
	local i=0
	until docker compose exec -T db pg_isready -U joust >/dev/null 2>&1; do
		i=$((i+1)); [ "$i" -gt 30 ] && { warn " (db not ready — skipped; server may hit P1000)"; return; }
		printf '.'; sleep 2
	done
	if docker compose exec -T db psql -U joust -d joust -v ON_ERROR_STOP=1 \
			-c "ALTER USER joust WITH PASSWORD '$PG_PW';" >/dev/null 2>&1; then
		say " ok"
		docker compose restart server >/dev/null 2>&1 || true   # retry with good creds
	else
		warn " (could not sync — inspect: docker compose logs db)"
	fi
}

# ── assemble & (optionally) launch ───────────────────────────────────────────
if [ "$STACK" = docker ]; then
	write_env
	# containerized proxy → in-compose Caddyfile; host proxy → rendered on start
	[ "$PROXY" = caddy ] && [ "$RUNTIME" = containerized ] && render_caddyfile
	[ "$SERVICE" = on ] && render_service
	# public URL + a local health-probe target.
	probe=""
	if [ "$RUNTIME" = host ]; then
		# apps published on loopback; probe the backend directly, url is the public host
		probe="http://127.0.0.1:$BACKEND_PORT/tournaments"
		if [ "$TLS" = on ] || [ "$TUNNEL" != none ]; then url="https://$HOST_IP"; else url="http://$HOST_IP"; fi
	elif [ "$TUNNEL" != none ]; then
		url="https://$HOST_IP"
	elif [ "$PROXY" = none ]; then
		url="http://$HOST_IP:$FRONTEND_PORT"; probe="http://127.0.0.1:$BACKEND_PORT/tournaments"
	else
		url="http://$HOST_IP$([ "$PROXY_HTTP_PORT" != 80 ] && echo ":$PROXY_HTTP_PORT")"
		probe="http://127.0.0.1:$PROXY_HTTP_PORT/api/backend/tournaments"
	fi
	banner "docker stack ready"
	say "  ${c_dim}COMPOSE_FILE=$(compose_list)${c_rst}"
	[ "$RUNTIME" = host ] && say "  ${c_dim}(host runtime — Caddy vhost + cloudflared config are written on start)${c_rst}"
	if [ "$TUNNEL" = cloudflared ] && [ "$RUNTIME" = containerized ]; then
		say "  ${c_bold}Cloudflare dashboard (manual):${c_rst} point the tunnel's public hostname"
		say "  ($HOST_IP) ingress at ${c_bold}http://caddy:80${c_rst}, and add an Access policy to lock it."
	fi
	if [ "$TLS" = on ]; then
		say "  ${c_bold}TLS:${c_rst} point $HOST_IP DNS (A/AAAA) at this box and open ports 80+443."
	fi
	if [ "$SERVICE" = on ]; then
		say "  ${c_bold}Boot service:${c_rst} sudo cp joust.service /etc/systemd/system/ && sudo systemctl enable --now joust.service"
	fi
	ask GO "Build & start now with 'docker compose up -d --build'? (y/N)" "N"
	if [[ "$GO" =~ ^[Yy] ]]; then
		docker compose up -d --build
		sync_db_password   # ensure the DB role password matches .env (stale-volume guard)
		if [ "$RUNTIME" = host ]; then
			render_host_caddy
			[ "$TUNNEL" = cloudflared ] && render_host_cloudflared
		fi
		if [ -n "$probe" ]; then
			printf '  waiting for stack'
			until curl -sf -o /dev/null "$probe" 2>/dev/null; do printf '.'; sleep 3; done; say " up"
		else
			say "  (no local port to probe — check: docker compose logs -f)"
		fi
		printf '%s✅ up:%s  %s\n' "$c_grn" "$c_rst" "$url"
	else
		say "  Later: ${c_bold}docker compose up -d --build${c_rst} (in $ROOT)"
		[ "$RUNTIME" = host ] && say "  ${c_dim}(host Caddy/cloudflared are written on start, not now)${c_rst}"
	fi
else
	# STACK=pm2 (native/host). Requires pm2 + a host toolchain. See notes below.
	write_env
	# Template lives in the backend repo (not copied here); render it into root
	# with absolute app cwds so pm2 finds the built artifacts regardless of names.
	sed -e "s|__NODE_ENV__|$NODE_ENV|; s|__BACKEND_PORT__|$BACKEND_PORT|; s|__FRONTEND_PORT__|$FRONTEND_PORT|" \
	    -e "s|__DATABASE_URL__|postgresql://joust:$PG_PW@localhost:5433/joust?schema=public|" \
	    -e "s|__JWT_SECRET__|$JWT_SECRET|; s|__ADMIN_PASSWORD__|$ADMIN_PW|" \
	    -e "s|__ALLOWED_ORIGINS__|$ORIGINS|; s|__SOCKET_ALLOWED_ORIGINS__|$ORIGINS|; s|__HOST_IP__|$HOST_IP|" \
	    -e "s|__SERVER_DIR__|$JOUST_SERVER_DIR|; s|__FRONTEND_DIR__|$JOUST_FRONTEND_DIR|" \
	    "$JOUST_SERVER_DIR/deploy/ecosystem.config.js.tmpl" > ecosystem.config.js
	banner "pm2 stack scaffolded"
	say "  Wrote ecosystem.config.js. Native/host build needs, per app: npm ci, npm run build,"
	say "  a running Postgres, and pm2 installed. (On npm 12 hosts you must first"
	say "  'npm install-scripts approve bcrypt sharp …' so native modules build.)"
	say "  Then: ${c_bold}pm2 start ecosystem.config.js${c_rst}"
	[ "$SERVICE" = on ] && say "  Boot service: ${c_bold}pm2 startup systemd && pm2 save${c_rst} (after pm2 start)"
	say "  ${c_dim}(pm2 path is best-effort — see docs/history.md.)${c_rst}"
fi
