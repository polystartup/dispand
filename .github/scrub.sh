#!/usr/bin/env bash
# Fails when a tracked file holds something that points at private infrastructure, or cites a
# design document, plan or decision kept outside this repository: say its reason instead.
# Lines listed in .github/scrub-allow.txt (one "path:line-text" per entry, exact match, no line
# number) are accepted.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# Case-sensitive: private address ranges, home paths, acronyms.
exact='10\.[0-9]+\.[0-9]+\.[0-9]+|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|\.home\.|/home/[a-z]|LXC|NPM\b|self-hosted,'
# Case-insensitive: infrastructure product names and words.
loose='proxmox|opnsense|doppler|nginx proxy manager|home network|home lan'
# Case-insensitive: a numbered design, spec, script, plan, decision, task, rule or slice (spelled with
# a space or a hyphen, as in a file name), a lettered plan or ruling, a section sign, a tour's step.
cited='\b(design|spec|script|plan|decision|task|rule|slice)s?[ -][0-9]{1,2}(\.[0-9]+)*\b|\b(plan|ruling)[ -][a-z][0-9]+\b|§ ?[0-9]|tour step [0-9]'

# git grep exits 1 when nothing matches (fine) and above 1 on a real error (fatal).
search() {
  local status=0
  git grep -nI "$@" --untracked -- . ':!.github/scrub.sh' ':!.github/scrub-allow.txt' || status=$?
  [ "$status" -le 1 ] || exit "$status"
}
hits=$({ search -E -e "$exact"; search -iE -e "$loose"; search -iE -e "$cited"; } | sort -u | sed -E 's/^([^:]*):[0-9]+:/\1:/')
left=$(printf '%s\n' "$hits" | grep -Fxv -f .github/scrub-allow.txt | grep -v '^$' || true)

if [ -n "$left" ]; then
  echo "Private material found (fix it, or allow the exact line in .github/scrub-allow.txt):"
  printf '%s\n' "$left"
  exit 1
fi
