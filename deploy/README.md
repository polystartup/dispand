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

## Run it

```sh
docker compose pull
docker compose up -d
```

Run them from this folder; run both again to update. Open `https://<DISPAND_HOST>` and create
the owner account with `DISPAND_SETUP_CODE`.

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
