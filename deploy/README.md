# Self-hosting Dispand

`compose.yaml` is the reference Compose project: the app's Docker image from
`ghcr.io/polystartup/dispand` and PostgreSQL, with their data in two named volumes
(`dispand-files` for attachments, `dispand-postgres` for the database). It runs on any host
with Docker Compose, behind a reverse proxy that terminates TLS.

## Variables

Compose reads them from the environment or from a `.env` file next to `compose.yaml`. Keep that
file out of version control and readable only by the account that runs Compose.

| Variable | Required | What it is |
| --- | --- | --- |
| `DISPAND_HOST` | yes | The name the app is served at, without a scheme (`dispand.example.com`). The app's URL is `https://<DISPAND_HOST>`. |
| `DISPAND_AUTH_SECRET` | yes | Signs sessions: a random string of at least 32 characters (`openssl rand -base64 32`). |
| `DISPAND_SECRET_KEY` | yes | Seals the API keys and tool headers stored in the database: 32 bytes, base64 (`openssl rand -base64 32`). Losing it loses those secrets; changing it makes them unreadable. |
| `DISPAND_SETUP_CODE` | yes | One-time code asked when the owner account is created on the first visit: at least 16 characters. |
| `DISPAND_POSTGRES_PASSWORD` | yes | Password of the `dispand` database user. |
| `DISPAND_IMAGE_TAG` | no | Image tag to run; `latest` by default. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | Where to send traces, metrics and logs over OTLP/HTTP (`http://collector:4318`). Unset: nothing is sent. Logs always also go to the container's output. |
| `OTEL_EXPORTER_OTLP_HEADERS` | no | Headers for the collector, such as its API key (`authorization=Bearer …`). |
| `OTEL_SERVICE_NAME` | no | The service name telemetry carries; `dispand` by default. |
| `DISPAND_TRACE_URL` | no | Where a trace is opened in your tracing tool, an `http(s)` URL with `{traceId}` in it (`https://traces.example.com/trace/{traceId}`). Set, the Audit page links each row's trace id there; unset, it shows the id to copy. |

## Run it

```sh
docker compose pull
docker compose up -d
```

Run them from this folder; run both again to update, after a backup (below). Open
`https://<DISPAND_HOST>` and create the owner account with `DISPAND_SETUP_CODE`.

## Back up and restore

An install's state is its database and its attachments, the two volumes. Back up both before
every `docker compose pull`: the new image migrates the database when it starts, and a migration
may rewrite or delete rows (see Upgrades), so without a backup there is no way back.

Keep the `.env` file, `DISPAND_SECRET_KEY` and `DISPAND_AUTH_SECRET` above all, apart from the
backups (in a password manager, say). The API keys and tool headers in a dump are sealed with
`DISPAND_SECRET_KEY`: a dump without it opens no stored secret, and whoever holds both opens them
all. Without `DISPAND_AUTH_SECRET`, every session ends and people sign in again.

Back up from this folder. The app stops for the time it takes, so the database and the files
match:

```sh
docker compose stop app
docker compose exec -T postgres pg_dump -U dispand -d dispand -Fc > dispand.dump
docker compose run --rm --no-deps -T --entrypoint tar app -czf - -C /data . > dispand-files.tar.gz
docker compose start app
```

Each run replaces the files of the one before, even when a command fails: once all four have
succeeded, copy the two files elsewhere, together.

Restore onto empty volumes: on a new host, with the same `DISPAND_SECRET_KEY` and
`DISPAND_AUTH_SECRET` in its `.env` (the dump holds no database password, so
`DISPAND_POSTGRES_PASSWORD` may be new), or here once `docker compose down -v` has deleted the
install's volumes for good. The app starts only once both restores have succeeded:

```sh
docker compose up -d --wait postgres &&
  docker compose exec -T postgres pg_restore -U dispand -d dispand --single-transaction < dispand.dump &&
  docker compose run --rm --no-deps -T --entrypoint tar app -xzf - -C /data < dispand-files.tar.gz &&
  docker compose up -d
```

Restore with the image the backup was taken with, or a later one: an older image doesn't know a
newer schema. To go back after an update, note the running image's commit before pulling
(`docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$(docker compose ps -q app)"`),
and restore with `DISPAND_IMAGE_TAG=sha-<its first 7 characters>`.

A snapshot of the volumes, taken with the stack stopped, works too. It restores only under the
PostgreSQL major version `compose.yaml` pins, where a dump also restores under a later one:

```sh
docker compose stop
docker compose run --rm --no-deps -T --entrypoint tar postgres -czf - -C /var/lib/postgresql . > dispand-postgres.tar.gz
docker compose run --rm --no-deps -T --entrypoint tar app -czf - -C /data . > dispand-files.tar.gz
docker compose start
```

It goes back onto empty volumes before anything starts (PostgreSQL started first would make a new
database under the files), with the `DISPAND_POSTGRES_PASSWORD` it was taken with: a snapshot
holds the database's password, so a new one is refused.

```sh
docker compose run --rm --no-deps -T --entrypoint tar postgres -xzf - -C /var/lib/postgresql < dispand-postgres.tar.gz &&
  docker compose run --rm --no-deps -T --entrypoint tar app -xzf - -C /data < dispand-files.tar.gz &&
  docker compose up -d
```

With PGlite (`DATABASE_URL=pglite:///<directory>`), the database is that directory. Stop the app
(PGlite holds its files open, so a copy taken while it runs may be torn), copy the directory and
`DISPAND_FILES_DIR`, and start it again. Restore by putting both copies back while it is stopped.

Rehearse a restore once, so you know the backups work. A Compose project of another name has
volumes of its own, so this leaves the install untouched:

```sh
docker compose -p dispand-check up -d --wait postgres
docker compose -p dispand-check exec -T postgres pg_restore -U dispand -d dispand --single-transaction < dispand.dump
docker compose -p dispand-check exec postgres psql -U dispand -d dispand -c 'select (select count(*) from "user") as people, (select count(*) from runs) as jobs'
docker compose -p dispand-check down
docker volume rm dispand-check_dispand-postgres
```

`/api/health` answers 200 while the app is up: its database answers and its scheduler
completed a tick in the last 5 minutes. Compose marks the container unhealthy otherwise
(`docker compose ps`).

## Upgrades

Dispand is a prototype with no production data, so upgrades are plain rewrites: a migration
that gives rows a workspace puts every existing row in the install's workspace when it has
exactly one, and otherwise deletes those rows. Where that would put two rows under one key (two
people's workspace settings, two tools of one name, two built-in skill packages), it keeps one,
the organization owner's when there is one, and deletes the others. Settings deleted this way go
back to their defaults; set them again after the upgrade. Tools connected by OAuth are signed
out and their actions ask again: connect them again, knowing that the account then serves the
whole workspace. The files limit becomes the organization's and starts again at 10 GiB: set it again
after the upgrade.

## Existing runner placement

The workspace migration preserves runner credentials. Installations with one workspace upgrade automatically.
If existing agents and job history identify different workspaces for a runner, or several workspaces
could own an unused runner, the migration rolls back and reports the affected runner IDs. The
previous version can still use the database. For the reference deployment, `docker compose logs postgres`
shows the database error and runner IDs. Open its database shell with
`docker compose exec postgres psql -U dispand -d dispand`.

Look up the runner and workspace names before assigning an ID.

```sql
SELECT id, name, owner_id FROM runners;
SELECT w.id, w.name, o.name AS organization FROM workspaces w JOIN organizations o ON o.id = w.organization_id;
CREATE TABLE IF NOT EXISTS public.dispand_runner_workspace_assignments (
  runner_id text PRIMARY KEY REFERENCES public.runners(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE
);
INSERT INTO public.dispand_runner_workspace_assignments (runner_id, workspace_id)
VALUES ('<reported runner ID>', '<chosen workspace ID>')
ON CONFLICT (runner_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id;
```

Retry the upgrade after recording each choice. A runner with active sessions can be assigned only
to their workspace. If it is serving several workspaces, finish those sessions on the previous version
before retrying. To revise a choice before the migration succeeds, update the mapping. PGlite uses
the same SQL with its data directory opened exclusively by the administrator.

## Reverse proxy

The app listens on port 3000 over plain HTTP. Put a reverse proxy in front of it that:

- terminates TLS for `DISPAND_HOST` and forwards to port 3000;
- sets `X-Real-IP` to the client address it saw, overwriting any value the client sent: the app
  reads that header alone for its sign-in rate limit;
- supports WebSockets on `/runner/ws`, where runners connect;
- turns response buffering off and allows a read timeout above 30 s: run and question streams
  are server-sent events with a heartbeat every 25 s;
- serves HTTP/2, so several browser tabs with live streams don't exhaust the browser's
  connections.

Nothing but the proxy may reach port 3000. `compose.yaml` publishes it on every interface of the
host: bind the mapping to the address only the proxy uses (`127.0.0.1:3000:3000` when the proxy runs
on the same host), or firewall the port. Ports published by Docker bypass host firewalls such as
ufw, so a firewall rule alone may not close it. A client reaching the port directly could choose its own `X-Real-IP`.
