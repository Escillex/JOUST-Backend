#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# One-shot secret bootstrap for the image-only ("docker compose up") deploy.
#
# setup.sh used to generate JWT_SECRET / SETTINGS_ENCRYPTION_KEY /
# POSTGRES_PASSWORD / ADMIN_PASSWORD into a .env on the host. Nothing runs on
# the host any more, so this container does it instead: it writes one file per
# secret into the `joust_secrets` volume, and only if that file is absent.
#
# Everything downstream reads those files — Postgres via POSTGRES_PASSWORD_FILE,
# the backend via docker-entrypoint.sh — so the volume is the single source of
# truth. An operator-supplied value (from .env) wins: it is written INTO the
# file, so a later `docker compose up` without that .env still works.
#
# ⚠ The volume is not disposable. SETTINGS_ENCRYPTION_KEY encrypts every full
#   database backup and the stored SMTP password; `docker compose down -v`
#   destroys it and makes existing backups permanently unreadable. Back it up
#   (deploy/release/README.md, "Keeping the secrets").
# ─────────────────────────────────────────────────────────────────────────────
set -eu

DIR="${JOUST_SECRETS_DIR:-/secrets}"
mkdir -p "$DIR"

# Randomness comes from node's crypto, not openssl — node is the one binary
# guaranteed to be in this image.
rand() { # $1 = encoding: hex | b64 | alnum, $2 = bytes (alnum: characters)
	case "$1" in
	hex)   node -e 'process.stdout.write(require("crypto").randomBytes(+process.argv[1]).toString("hex"))' "$2" ;;
	b64)   node -e 'process.stdout.write(require("crypto").randomBytes(+process.argv[1]).toString("base64"))' "$2" ;;
	# No +/=/ — this one ends up inside a postgresql:// URL, where those bytes
	# need percent-encoding and silently break DATABASE_URL parsing instead.
	alnum) node -e 'const n=+process.argv[1];let s="";while(s.length<n)s+=require("crypto").randomBytes(64).toString("base64").replace(/[^A-Za-z0-9]/g,"");process.stdout.write(s.slice(0,n))' "$2" ;;
	esac
}

# $1 = file name, $2 = env var that overrides it, $3 = encoding, $4 = size
ensure() {
	file="$DIR/$1"
	supplied=$(printenv "$2" 2>/dev/null || true)

	if [ -n "$supplied" ]; then
		# Operator set it in .env. Adopt it, so the file stays authoritative.
		printf '%s' "$supplied" >"$file"
		printf '  %-26s from .env (%s)\n' "$1" "$2"
	elif [ -s "$file" ]; then
		printf '  %-26s kept\n' "$1"
	else
		rand "$3" "$4" >"$file"
		printf '  %-26s generated\n' "$1"
		eval "NEW_$2=1"
	fi

	# 0600 everywhere except the Postgres password: the official postgres
	# entrypoint re-execs itself as the `postgres` user and re-reads
	# POSTGRES_PASSWORD_FILE on that second pass, so a root-only file makes the
	# database fail to start. The volume is private to this stack either way.
	if [ "$1" = postgres_password ]; then chmod 0644 "$file"; else chmod 0600 "$file"; fi
}

echo "JOUST · secrets in $DIR"
ensure jwt_secret             JWT_SECRET              b64   48
ensure settings_encryption_key SETTINGS_ENCRYPTION_KEY hex   32
ensure postgres_password      POSTGRES_PASSWORD       alnum 24
ensure admin_password         ADMIN_PASSWORD          alnum 16

# The admin password is the only generated secret a human has to type, so print
# it — but only on the run that created it, never on subsequent boots.
if [ -n "${NEW_ADMIN_PASSWORD:-}" ]; then
	cat <<-BANNER

	  ┌──────────────────────────────────────────────────────────┐
	  │  Administrator account created                           │
	  │  email:    $(printf '%-46s' "${ADMIN_EMAIL:-admin@joust.local}")│
	  │  password: $(printf '%-46s' "$(cat "$DIR/admin_password")")│
	  │                                                          │
	  │  Change it after signing in. To see it again:            │
	  │  docker compose run --rm --entrypoint sh init \          │
	  │    -c 'cat /secrets/admin_password'                      │
	  └──────────────────────────────────────────────────────────┘

	BANNER
fi
