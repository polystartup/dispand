#!/bin/sh
# Installs the Dispand runner for the current user (no sudo) and starts it as the systemd
# user service dispand-runner.service. Dispand shows the command to run:
#   curl -fsSL https://<server>/runner/install.sh | DISPAND_PAIRING_CODE=<code> sh -s -- --server https://<server>
# Update an installed runner in place (Settings shows it for outdated runners):
#   curl -fsSL https://<server>/runner/install.sh | sh -s -- --update
# It replaces the code and the unit, keeps config.json (server, roots, token) untouched, and restarts the unit.
# Options: --root <dir> (default ~/dispand): where sessions may work. The pairing code comes
# from the environment, never the command line (which other local users can read). Everything
# that can fail on this machine is done before the single-use code is spent; running it again
# after a failure resumes without pairing again if this server's token is already saved (to
# pair again, after revoking the runner, delete ~/.config/dispand-runner/config.json first).
set -eu

# Kept in a shell variable only: no command started from here inherits it, except `pair`.
code="${DISPAND_PAIRING_CODE:-}"
unset DISPAND_PAIRING_CODE

server=""
root="$HOME/dispand"
update=""
while [ $# -gt 0 ]; do
  case "$1" in
    --server) server="${2:-}"; shift 2 ;;
    --root) root="${2:-}"; shift 2 ;;
    --update) update=1; shift ;;
    *) echo "install.sh: unknown option $1" >&2; exit 2 ;;
  esac
done

node_bin="$(command -v node || true)"
if [ -z "$node_bin" ]; then
  echo "install.sh: Node.js 22 or later is needed (node is not on PATH)" >&2
  exit 1
fi
if ! "$node_bin" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  echo "install.sh: Node.js 22 or later is needed (found $("$node_bin" --version))" >&2
  exit 1
fi

# The runner's config dir, named to the service explicitly: the user manager may not share this shell's XDG_CONFIG_HOME.
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/dispand-runner"
# Reads the saved server of a paired runner (one with a token, in config.json or an older runner's token file).
paired_server() {
  "$node_bin" -e '
    const fs = require("fs");
    const c = JSON.parse(fs.readFileSync(process.argv[1] + "/config.json", "utf8"));
    const token = c.token || (fs.existsSync(process.argv[1] + "/token") && fs.readFileSync(process.argv[1] + "/token", "utf8").trim());
    if (typeof c.server !== "string" || !token) process.exit(1);
    process.stdout.write(c.server);
  ' "$config_dir" 2>/dev/null
}
if [ -n "$update" ] && [ -z "$server" ]; then
  if ! server="$(paired_server)"; then
    echo "install.sh: the runner is not installed here (no paired $config_dir/config.json): install it with the command Dispand shows" >&2
    exit 2
  fi
fi
if [ -z "$server" ]; then
  echo "usage: DISPAND_PAIRING_CODE=<code> install.sh --server <url> [--root <dir>], or install.sh --update" >&2
  exit 2
fi
server="${server%/}"

# The runner's code and its token travel to and from this server: https only, except to this
# machine itself (localhost, 127.0.0.0/8, ::1) for development.
proto='=https'
# Userinfo ("user:pass@host") would hide the real host from the checks below.
authority="${server#*://}"
authority="${authority%%/*}"
case "$authority" in
  *@*)
    echo "install.sh: the server URL must be a plain https://host (no user info: @)" >&2
    exit 2
    ;;
esac
case "$server" in
  https://*) ;;
  http://*)
    host="${server#http://}"
    host="${host%%/*}"
    case "$host" in
      "[::1]" | "[::1]:"*) ;;
      *)
        host="${host%:*}"
        if [ "$host" != localhost ] && ! printf '%s\n' "$host" | grep -Eqx '127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}'; then
          echo "install.sh: the server must use https (plain http only on localhost, 127.0.0.0/8 or ::1)" >&2
          exit 2
        fi
        ;;
    esac
    proto='=http'
    ;;
  *)
    echo "install.sh: the server must use https (plain http only on localhost, 127.0.0.0/8 or ::1)" >&2
    exit 2
    ;;
esac

# Claude Code 2.1.248 or later: the first with the input mode that keeps remote text from running built-in commands.
if ! command -v claude >/dev/null 2>&1; then
  echo "install.sh: warning: claude is not on PATH, Claude Code sessions will fail" >&2
elif ! claude --version 2>/dev/null | "$node_bin" -e '
  const v = require("fs").readFileSync(0, "utf8").trim().split(/\s+/)[0].split(".").map(Number);
  const min = [2, 1, 248];
  const i = min.findIndex((m, k) => v[k] !== m);
  process.exit(i === -1 || v[i] > min[i] ? 0 : 1);
'; then
  echo "install.sh: warning: Claude Code 2.1.248 or later is needed (claude --version): sessions will be refused until it is updated" >&2
fi

dest="${XDG_DATA_HOME:-$HOME/.local/share}/dispand-runner"
# Where the user manager looks for units: its own XDG_CONFIG_HOME, else ~/.config.
manager_config="$(systemctl --user show-environment 2>/dev/null | sed -n 's/^XDG_CONFIG_HOME=//p')"
units="${manager_config:-$HOME/.config}/systemd/user"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --proto "$proto" --tlsv1.2 "$server/runner/dispand-runner.tgz" -o "$tmp/runner.tgz"
tar -xzf "$tmp/runner.tgz" -C "$tmp"
mkdir -p "$(dirname "$dest")"
rm -rf "$dest.old"
if [ -e "$dest" ]; then mv "$dest" "$dest.old"; fi
mv "$tmp/dispand-runner" "$dest"
rm -rf "$dest.old"

# Escapes a value for the right-hand side of a sed s|...|...| command.
esc() { printf '%s' "$1" | sed 's/[&|\\]/\\&/g'; }
mkdir -p "$units"
sed -e "s|@NODE@|$(esc "$node_bin")|" -e "s|@DEST@|$(esc "$dest")|" -e "s|@PATH@|$(esc "$PATH")|" \
  -e "s|@CONFIG@|$(esc "$config_dir")|" \
  "$dest/dispand-runner.service" >"$tmp/unit"
# The CLIs' user config dirs, when this shell sets them: the user manager doesn't have them.
# Made absolute: the CLI would resolve a relative one against each session's directory.
claude_env=""
if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
  claude_config_dir="$(cd "$CLAUDE_CONFIG_DIR" && pwd -P)"
  claude_env="Environment=\"CLAUDE_CONFIG_DIR=$claude_config_dir\""
fi
codex_env=""
if [ -n "${CODEX_HOME:-}" ]; then
  codex_home="$(cd "$CODEX_HOME" && pwd -P)"
  codex_env="Environment=\"CODEX_HOME=$codex_home\""
fi
# An update run from a shell without them keeps the installed unit's: the runner must not lose its CLIs' homes.
if [ -n "$update" ] && [ -f "$units/dispand-runner.service" ]; then
  [ -n "$claude_env" ] || claude_env="$(grep '^Environment="CLAUDE_CONFIG_DIR=' "$units/dispand-runner.service" || true)"
  [ -n "$codex_env" ] || codex_env="$(grep '^Environment="CODEX_HOME=' "$units/dispand-runner.service" || true)"
fi
awk -v claude="$claude_env" -v codex="$codex_env" '
  { print }
  /^\[Service\]$/ { if (claude != "") print claude; if (codex != "") print codex }
' "$tmp/unit" >"$units/dispand-runner.service.tmp"
mv "$units/dispand-runner.service.tmp" "$units/dispand-runner.service"
# Written, not enabled yet: pairing comes only once the unit is in place.
test -s "$units/dispand-runner.service"

# Paired already with this server (a rerun after a later failure): the saved token is kept. It
# is in config.json (an older runner kept it in a separate token file).
if [ "$(paired_server || true)" = "$server" ]; then
  [ -n "$update" ] || echo "Already paired with $server: keeping the saved token."
elif [ -n "$update" ]; then
  echo "install.sh: --update keeps this machine's pairing, but it isn't paired with $server" >&2
  exit 2
elif [ -z "$code" ]; then
  echo "install.sh: set DISPAND_PAIRING_CODE to the pairing code Dispand shows" >&2
  exit 2
else
  DISPAND_PAIRING_CODE="$code" "$node_bin" "$dest/main.mjs" pair --config "$config_dir" --server "$server" --root "$root"
fi
code=""

systemctl --user daemon-reload
systemctl --user enable dispand-runner.service
systemctl --user restart dispand-runner.service
if [ -n "$update" ]; then
  echo "Dispand runner updated and restarted (systemctl --user status dispand-runner)."
  exit 0
fi
echo "Dispand runner installed and started (systemctl --user status dispand-runner)."
echo "To keep it running while you are logged out: loginctl enable-linger"
