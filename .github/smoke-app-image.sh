#!/usr/bin/env bash
# Smoke test of the app image: `.github/smoke-app-image.sh <image> [previous-image]`.
# Starts the image as deploy/compose.yaml does, on an empty PostgreSQL, and checks it answers:
# /api/health (which runs the migrations), / and /login redirecting to /setup (no account yet),
# /setup. Then starts it again on the same database (migrations are idempotent on restart). With a
# previous image (the published `latest`), it then starts that one on a new database and the image
# over it, so a migration that can't run on the schema it left fails here.
set -euo pipefail
image="$1" previous="${2:-}"
net="dispand-smoke-$$"
# Throwaway values, valid for this run only.
env=(
  -e DATABASE_URL=postgres://dispand:smoke@postgres:5432/dispand
  -e BETTER_AUTH_URL=http://localhost:3000
  -e BETTER_AUTH_SECRET=smoke-only-secret-0123456789abcdef
  -e DISPAND_SETUP_CODE=smoke-setup-code-0123456789
  -e DISPAND_SECRET_KEY="$(openssl rand -base64 32)"
  -e DISPAND_FILES_DIR=/data/files
)

cleanup() { docker rm -fv "$net-app" "$net-pg" >/dev/null 2>&1 || true; docker network rm "$net" >/dev/null 2>&1 || true; docker volume rm "$net-files" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker network create "$net" >/dev/null

# Starts an empty PostgreSQL, as compose does.
postgres() {
  docker rm -fv "$net-pg" >/dev/null 2>&1 || true
  docker run -d --name "$net-pg" --network "$net" --network-alias postgres \
    -e POSTGRES_USER=dispand -e POSTGRES_PASSWORD=smoke -e POSTGRES_DB=dispand \
    -e POSTGRES_INITDB_ARGS="--locale-provider=builtin --locale=C.UTF-8" \
    postgres:18@sha256:3a4264520e121176619f54ff867d12774bc81e95e7b84db58d63bccdb6144b81 >/dev/null
  for _ in $(seq 60); do docker exec "$net-pg" pg_isready -q -U dispand -d dispand && break; sleep 1; done
}

# Starts $1 as compose does, waits for /api/health to answer 200, and checks the pages.
start() {
  docker rm -f "$net-app" >/dev/null 2>&1 || true
  docker run -d --name "$net-app" --network "$net" -p 127.0.0.1:3000:3000 "${env[@]}" \
    --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
    -v "$net-files:/data" "$1" >/dev/null
  local status=""
  for _ in $(seq 90); do
    status=$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health || true)
    [ "$status" = 200 ] && break
    sleep 1
  done
  if [ "$status" != 200 ]; then
    echo "::error::$1 did not answer 200 on /api/health (last: ${status:-none})"
    docker logs "$net-app"
    exit 1
  fi
  check / 307 /setup
  check /login 307 /setup
  check /setup 200
  echo "ok: $1"
}

# check <path> <status> [location]
check() {
  local out
  out=$(curl -s -m 10 -o /dev/null -w '%{http_code} %{redirect_url}' "http://127.0.0.1:3000$1" || true)
  if [ "${out%% *}" != "$2" ] || { [ -n "${3:-}" ] && [ "${out#* }" != "http://127.0.0.1:3000$3" ]; }; then
    echo "::error::GET $1 answered '$out', expected $2 ${3:-}"
    docker logs "$net-app"
    exit 1
  fi
}

postgres
start "$image"
start "$image"
if [ -n "$previous" ]; then
  postgres
  start "$previous"
  start "$image"
fi
