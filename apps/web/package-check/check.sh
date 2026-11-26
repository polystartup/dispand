#!/usr/bin/env bash
# Installs the packed @dispand/web, @dispand/domain and @dispand/runner-protocol in a project
# outside the repository and runs `entry.ts` there against PostgreSQL.
# Usage, after `pnpm build`: DATABASE_URL=postgres://… apps/web/package-check/check.sh
# The database must be empty: the entry sets up the first owner.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
: "${DATABASE_URL:?a PostgreSQL URL}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

for pkg in packages/runner-protocol packages/domain apps/web; do
  (cd "$repo/$pkg" && pnpm pack --pack-destination "$work" >/dev/null)
done
tgz() { echo "file:$(ls "$work"/dispand-"$1"-*.tgz)"; }
cat >"$work/package.json" <<EOF
{
  "name": "package-check",
  "private": true,
  "type": "module",
  "dependencies": { "@dispand/web": "$(tgz web)", "@dispand/domain": "$(tgz domain)", "pg": "^8.23.1" },
  "devDependencies": { "typescript": "^6.0.3", "@types/node": "^26.6.6", "@types/pg": "^8.23.1", "@types/react": "^19.3.0" }
}
EOF
# The packages ask for each other by version, which no registry has: the tarballs stand in.
cat >"$work/pnpm-workspace.yaml" <<EOF
overrides:
  "@dispand/domain": "$(tgz domain)"
  "@dispand/runner-protocol": "$(tgz runner-protocol)"
EOF
cp "$here/entry.ts" "$here/types.ts" "$here/shell.ts" "$work/"
cat >"$work/tsconfig.json" <<EOF
{
  "compilerOptions": { "target": "ES2023", "module": "NodeNext", "strict": true, "skipLibCheck": true, "noEmit": true, "types": ["node"] },
  "files": ["entry.ts", "types.ts", "shell.ts"]
}
EOF
(cd "$work" && pnpm install --config.minimum-release-age=0 >/dev/null)

cd "$work"
# The entries compile under `strict` against the packed declarations, with no shim.
node_modules/.bin/tsc
DATABASE_URL="$DATABASE_URL" \
  BETTER_AUTH_URL="http://127.0.0.1:3998" \
  BETTER_AUTH_SECRET="package-check-secret-0123456789abcdef" \
  DISPAND_SETUP_CODE="package-check-setup-0123" \
  DISPAND_SECRET_KEY="$(openssl rand -base64 32)" \
  DISPAND_FILES_DIR="$work/files" \
  PORT=3998 HOST=127.0.0.1 \
  node entry.ts
