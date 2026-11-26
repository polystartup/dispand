#!/usr/bin/env bash
# The app image built with the fixture web shell (`apps/web/src/shell/fixture.tsx`), as an
# embedding build builds it: `.github/shell-fixture-check.sh <image>`, from the repository root.
# Checks that its client holds the fixture's text, and that a page it serves carries the page policy
# a shell can't change (`apps/web/src/server/page-security.ts`).
set -euo pipefail
image="$1"
net="dispand-shell-$$"

if ! docker run --rm --entrypoint grep "$image" -rqF "Entrée de la fixture" dist/client; then
  echo "::error::the client built with the fixture shell lacks its text"
  exit 1
fi
expected=$(node -e 'import("./apps/web/src/server/page-security.ts").then((m) => console.log(m.PAGE_CSP))')

cleanup() { docker rm -fv "$net-app" "$net-pg" >/dev/null 2>&1 || true; docker network rm "$net" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker network create "$net" >/dev/null
docker run -d --name "$net-pg" --network "$net" --network-alias postgres \
  -e POSTGRES_USER=dispand -e POSTGRES_PASSWORD=shell -e POSTGRES_DB=dispand \
  -e POSTGRES_INITDB_ARGS="--locale-provider=builtin --locale=C.UTF-8" \
  postgres:18@sha256:3a4264520e121176619f54ff867d12774bc81e95e7b84db58d63bccdb6144b81 >/dev/null
for _ in $(seq 60); do docker exec "$net-pg" pg_isready -q -U dispand -d dispand && break; sleep 1; done
# Throwaway values, valid for this run only.
docker run -d --name "$net-app" --network "$net" -p 127.0.0.1::3000 \
  -e DATABASE_URL=postgres://dispand:shell@postgres:5432/dispand \
  -e BETTER_AUTH_URL=http://localhost:3000 \
  -e BETTER_AUTH_SECRET=shell-only-secret-0123456789abcdef \
  -e DISPAND_SETUP_CODE=shell-setup-code-0123456789 \
  -e DISPAND_SECRET_KEY="$(openssl rand -base64 32)" \
  -e DISPAND_FILES_DIR=/tmp/files \
  "$image" >/dev/null
app="http://$(docker port "$net-app" 3000/tcp | head -1)"

status=""
for _ in $(seq 90); do
  status=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$app/api/health" || true)
  [ "$status" = 200 ] && break
  sleep 1
done
if [ "$status" != 200 ]; then
  echo "::error::the image built with the fixture shell did not answer 200 on /api/health (last: ${status:-none})"
  docker logs "$net-app"
  exit 1
fi
response=$(curl -s -m 10 -D - -o /dev/null "$app/setup" | tr -d '\r')
if ! grep -q '^HTTP/[0-9.]* 200' <<<"$response"; then
  echo "::error::/setup of the image built with the fixture shell did not answer 200: $(head -1 <<<"$response")"
  docker logs "$net-app"
  exit 1
fi
policy=$(sed -n 's/^content-security-policy: //Ip' <<<"$response")
if [ "$policy" != "$expected" ]; then
  echo "::error::a page of the image built with the fixture shell is served with another policy: ${policy:-none}"
  exit 1
fi
echo "ok: $image holds the fixture shell's text and keeps the page policy"
