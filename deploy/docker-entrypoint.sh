#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Backend container entrypoint.
#
# Two jobs, in order:
#   1. Fill in any secret that was not passed as an environment variable, by
#      reading the file init-secrets.sh wrote into the shared /secrets volume.
#      DATABASE_URL is assembled here for the same reason — it embeds the
#      Postgres password, which compose cannot interpolate out of a file.
#   2. Apply migrations and run the (guarded) seed, then hand off to CMD.
#
# An explicit environment variable always wins over the file, so the pm2 and
# build-from-source paths — which set everything in .env and mount no /secrets —
# pass straight through this script unchanged.
# ─────────────────────────────────────────────────────────────────────────────
set -eu

SECRETS_DIR="${JOUST_SECRETS_DIR:-/secrets}"

# $1 = env var, $2 = file under $SECRETS_DIR
from_file() {
	eval "current=\${$1:-}"
	[ -n "$current" ] && return 0
	[ -r "$SECRETS_DIR/$2" ] || return 0
	export "$1=$(cat "$SECRETS_DIR/$2")"
}

from_file JWT_SECRET              jwt_secret
from_file SETTINGS_ENCRYPTION_KEY settings_encryption_key
from_file ADMIN_PASSWORD          admin_password
from_file POSTGRES_PASSWORD       postgres_password

if [ -z "${DATABASE_URL:-}" ]; then
	[ -n "${POSTGRES_PASSWORD:-}" ] || {
		echo "entrypoint: neither DATABASE_URL nor a Postgres password is set." >&2
		exit 1
	}
	export DATABASE_URL="postgresql://${POSTGRES_USER:-joust}:${POSTGRES_PASSWORD}@${POSTGRES_HOST:-db}:${POSTGRES_PORT:-5432}/${POSTGRES_DB:-joust}?schema=public"
fi

# Schema first, then the seed — which is guarded (it will not touch an existing
# admin or re-create built-in formats), so it is safe on every restart and is
# what gives a fresh database its first administrator. Skippable for the rare
# case of running a second replica that must not race the first one.
if [ "${JOUST_SKIP_MIGRATIONS:-}" != "1" ]; then
	npx prisma migrate deploy
	npx prisma db seed
fi

exec "$@"
