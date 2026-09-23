# Running JOUST from published images

Two files, one command, no build step. This replaces `setup.sh` for anyone who
just wants the application running.

```sh
curl -O https://raw.githubusercontent.com/Escillex/JOUST-Backend/main/deploy/release/compose.yml
docker compose up -d
```

Open <http://localhost:8080>. The administrator's password is printed once, by
the `init` service, during the first `up`:

```sh
docker compose logs init
```

If the host already runs an older `setup.sh` deployment, check `docker compose ls`
first: that stack is also called `joust`, and this file would adopt its
containers instead of creating its own. Give the new one its own name with
`docker compose -p joust-images up -d`.

Requires Docker Compose **v2.23 or newer** (the compose file inlines the Caddy
configuration rather than shipping a second file).

## What comes up

| Service | Image | Role |
|---|---|---|
| `init` | `ghcr.io/escillex/joust-backend` | Runs once, generates any missing secret, exits |
| `db` | `postgres:17-alpine` | Database; no host port |
| `server` | `ghcr.io/escillex/joust-backend` | API; migrates and seeds on start |
| `new` | `ghcr.io/escillex/joust-frontend` | Next.js standalone bundle |
| `caddy` | `caddy:2-alpine` | The only published service |

Caddy is not optional. Next does not forward `/socket.io/`, so without a proxy
routing it to the backend, realtime falls back to polling permanently — and
routing everything through one origin is also what keeps sessions and CORS
simple.

First boot is slow: the backend applies migrations and seeds before it listens,
and Caddy returns 502 until it does. A minute is normal.

## Configuration

Everything is optional. Copy `.env.example` to `.env` beside `compose.yml` to
change any of it. The common cases:

**A different port**

```sh
JOUST_HTTP_PORT=9000
JOUST_PUBLIC_URL=http://localhost:9000
```

**A real domain, with automatic HTTPS**

```sh
JOUST_SITE_ADDRESS=joust.example.com
JOUST_PUBLIC_URL=https://joust.example.com
JOUST_HTTP_PORT=80
JOUST_HTTPS_PORT=443
```

Point the DNS record at the host first — Caddy requests the certificate on
startup and needs ports 80 and 443 to complete the challenge.

`JOUST_PUBLIC_URL` is not cosmetic: the backend refuses to start in production
without an origin allowlist, and this is what fills it.

## Keeping the secrets

On first boot `init` writes four files into the `secrets` volume:

| File | What it protects |
|---|---|
| `jwt_secret` | Session tokens. Changing it signs everyone out. |
| `settings_encryption_key` | **Database backups and the stored SMTP password.** |
| `postgres_password` | The database. |
| `admin_password` | The seeded administrator account. |

> **`docker compose down -v` deletes this volume**, and with it the only copy of
> `settings_encryption_key`. Every `.joustql` full backup you have taken becomes
> permanently undecryptable. `down` without `-v` is safe.

Copy them somewhere safe once:

```sh
docker compose run --rm --entrypoint sh init -c 'cd /secrets && tar c .' > joust-secrets.tar
```

To rebuild the stack elsewhere with those values, put them in `.env`
(`JWT_SECRET=`, `SETTINGS_ENCRYPTION_KEY=`, …) — `init` adopts a supplied value
into the volume instead of generating a new one.

## Operating it

```sh
docker compose pull && docker compose up -d   # update to the latest images
docker compose logs -f server                 # backend logs (mail codes land here)
docker compose exec db psql -U joust joust    # database shell
docker compose down                           # stop, keep all data
```

Pin a version rather than tracking `latest` on anything you care about:
`JOUST_VERSION=v1.0.0` in `.env`.

Uploaded images, database backups and Postgres data live in the `images`,
`backups` and `pgdata` volumes and survive `down`, `pull` and `up`.

## When to use `setup.sh` instead

This stack covers one deployment shape: a single host, Caddy in front, direct
HTTP(S). The interactive `setup.sh` (see `deploy.md`) still handles the rest —
building from source, the pm2 stack, a Cloudflare tunnel, running a second
isolated instance beside an existing one.
