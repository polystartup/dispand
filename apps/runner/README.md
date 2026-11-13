# dispand-runner

The runner Dispand drives CLI agents through. It runs on the machine where the agents work,
as the signed-in user, and dials out to the Dispand server over a WebSocket
(`/runner/ws`): no inbound port, no SSH. Claude Code sessions go through the Claude Agent SDK,
which spawns the machine's own `claude` (on `PATH`) with the user's settings, plugins and MCP
servers. The runner holds no API key and never touches the CLI's credentials.

## Install

In Dispand, add a runner: it shows a one-line command with a single-use pairing code.

```sh
curl -fsSL https://<server>/runner/install.sh | DISPAND_PAIRING_CODE=<code> sh -s -- --server https://<server> [--root <dir>]
```

`install.sh` (POSIX sh, no sudo) needs Node.js 22 or later and `claude` on `PATH`, Claude
Code 2.1.248 or later (sessions are refused on older versions; the runner reports the version
it found in `hello`). Codex is optional: when `codex` is on `PATH`, the runner reads its
version and asks its `app-server` (`account/read`) whether it is signed in, at start, logs
both and reports them in `hello` (an app-server that fails or doesn't answer within 15 s is
stopped and reported as no Codex); it never reads the account's email or tokens, never starts a login and refuses Codex's
token-refresh and attestation requests. Codex sessions need Codex 0.166.0 or later (the
version `src/codex/protocol` is generated from, with `pnpm --filter @dispand/runner
codex:types`). The pairing code comes from `DISPAND_PAIRING_CODE`, never the command line (other local users
can read argv), and only `pair` gets it, through its environment. It downloads
`dispand-runner.tgz` into `~/.local/share/dispand-runner`, writes the systemd user unit
`dispand-runner.service` (with the installing shell's `PATH`, in the directory the user
manager reads units from: its own `XDG_CONFIG_HOME`, else `~/.config/systemd/user`; the unit
names the config directory with `--config`), then pairs (writing the config below), then
enables and starts the unit. Run again after a failure, it skips pairing when a token for
that server is already saved; to pair again (after revoking the runner), delete
`~/.config/dispand-runner/config.json` first.
To keep the runner up while you are logged out: `loginctl enable-linger`.

Update: when Dispand speaks a newer runner protocol, it refuses the runner (HTTP 426, logged by
the runner) and Settings shows it as needing an update, with this command to run on its machine:

```sh
curl -fsSL https://<server>/runner/install.sh | sh -s -- --update
```

It takes the server from `config.json` (the same https rule applies), downloads the new code,
writes the unit again (keeping its `CLAUDE_CONFIG_DIR` and `CODEX_HOME` unless this shell sets
them) and restarts it. `config.json` (server, roots, `allowBypass`, `mcpServers`, token) is
left byte for byte as it was, and nothing is paired again.

Uninstall: `systemctl --user disable --now dispand-runner`, then remove
`~/.config/systemd/user/dispand-runner.service`, `~/.local/share/dispand-runner` and
`~/.config/dispand-runner`, and revoke the runner in Dispand.

## Configuration

`~/.config/dispand-runner/config.json` belongs to the machine: the server can't change it.

```json
{ "server": "https://dispand.example", "roots": ["/srv/dispand"], "allowBypass": false }
```

- `server`: `https://` (plain `http://` only on localhost, 127.0.0.0/8 or ::1, for
  development: the token goes out with every connection). `install.sh` applies the same rule
  and downloads with `curl --proto =https --tlsv1.2`.
- `roots`: where sessions run. Sessions run only in fresh per-run folders: each gets a new
  `<roots[0]>/runs/<runKey>`, refused if it already exists. The path from the root to it holds
  no symlink: the runner makes `runs` itself, a real directory, and the folder's real path must
  be exactly `<root>/runs/<runKey>`. A prompt or message from Dispand that starts with `/name` runs only if
  it is a skill or plugin/custom command (`supportedCommands()` not built in); any other one
  goes as written, so a built-in such as `/config` never runs. Text with an `@` goes as written too (no `@file`
  reads before the permission checks). Other text goes as usual. Plan mode writes its plans to the run folder's
  `.dispand/plans` (the CLI's `plansDirectory`), not `~/.claude/plans`, which is out of the
  boundary. Resuming a CLI session reuses the folder it ran in, only
  for a session id this runner recorded for that run key (`sessions.json`, mode 0600).
  Sessions load your user settings only: a run folder's own `.claude/` settings and hooks,
  `.mcp.json` and `CLAUDE.md` never load by themselves.
- `allowBypass`: unless `true`, a session asking for `bypassPermissions` is refused.
  When allowed, the runner automatically approves native commands and file operations, subject
  to its protected-path checks; unresolved file paths still ask. Managed Job tools still follow their per-agent Run / Ask settings.
  Claude Code always gets `permissions.disableBypassPermissionsMode: "disable"`: the runner
  implements bypass so it cannot skip managed tool checks.
- `mcpServers` (optional): the MCP servers this machine runs for Dispand's runner tools,
  by name (letters, digits, `_` and `-`, at most 64; not `dispand`; at most 100):

  ```json
  "mcpServers": {
    "fetch": { "command": "uvx", "args": ["mcp-server-fetch"] },
    "brave-search": { "command": "npx", "args": ["-y", "@brave/brave-search-mcp-server"], "env": { "BRAVE_API_KEY": "<your key>" } }
  }
  ```

  The runner reports the names to Dispand (never the commands or `env`), and these are the
  only commands it ever starts for a session's tools. Dispand's tool catalog shows the
  snippet for its runner entries. Restart the runner after adding one, then add it in
  Dispand (Settings → Tools → Add runner tool) by picking this runner.

  A server may also have `pollable`: the actions Dispand's polls may call besides those the
  server itself marks read-only. Polls call the read-only ones without it; `"pollable": []`
  forbids every poll on that server.

File tools read and write only inside the session folder (reads also inside the CLI's
`plugins/cache`, `plugins/marketplaces` and `skills/`, where skills keep their own files, and
the session's own skill packages; never
plugins' `data/` or `store/`; never credentials, settings, hooks,
`.claude.json`, this runner's config or `~/.codex`). Edits also stay out of any `.claude/` and
`.mcp.json` in it; Bash still asks per command, every one (the same hook makes the CLI ask even for the
commands it would auto-approve, such as `cp` in acceptEdits; Monitor, PowerShell and Workflow too,
everywhere but `bypassPermissions`). A PreToolUse hook denies, before every tool call and in
every permission mode, any file-tool edit whose target's real path (symlinks followed) is
outside the working directory, inside a `.claude/` or `.mcp.json` at any depth, or inside where
a symlink in those, or in the CLI's user settings, hooks and `.claude.json`, leads (followed
transitively). Past 1000 entries in those trees, or 10,000 directories searched in the working
tree (`node_modules` and `.git` are skipped), every edit is denied. A root, or a working
directory, that is or sits inside a `.claude`/`.mcp.json`, or that contains or sits inside
this runner's config dir, the CLI's user config dir (`$CLAUDE_CONFIG_DIR` or `~/.claude`),
`~/.claude.json` or Codex's home (`$CODEX_HOME` or `~/.codex`), is refused: don't use `~` as a root. A `CLAUDE_CONFIG_DIR` or `CODEX_HOME` is made absolute
(it must exist) when the runner starts and passed to the CLI as such; `install.sh` writes each
one that is set, as an absolute path, into the unit. Keep your own configuration (plugin
hooks included) from linking into agent work folders. An "always allow" answer only adds
rules to the running session.

The token is in `config.json` itself, which is why the file is mode 0600 (a separate `token`
file from an older runner is moved in on start); the last event number in
`state/<runnerId>/state.json`; events Dispand hasn't acknowledged yet in
`state/<runnerId>/backlog.jsonl` (mode 0600,
synced at once for results, errors, questions and turn ends, within a second for text), sent
again after a restart. Restart the unit after editing the config.

Skills: a session that asks for skill packages gets each one from Dispand
(`GET /runner/packages/<id>`, with the runner's token) before its folder is made; a failure ends
it with an `error` and no folder. They are written read-only (files 0444, folders 0555), as
plugins holding only the runner's own `.claude-plugin/plugin.json` and `skills/`, under
`$XDG_STATE_HOME/dispand-runner/sessions/` (else `~/.local/state/dispand-runner/`). That
folder may not overlap a root or the machine's config. The session can read them, not edit them.
Each `SKILL.md` is written with only `name` and `description` in its frontmatter (no hooks or
tool grants reach the CLI), and every `@` in it becomes `＠` (no file mentions). Sessions
run with `disableSkillShellExecution`: no skill (yours included) runs a shell command as it loads.
They are removed when the session ends and when the runner starts. Call one as
`/<package>:<skill>`.

Codex: each Codex session runs its own `codex app-server` in its run folder, with approval policy
`untrusted` and the permission profile `dispand` (`src/codex/config.ts`): Codex's
`:workspace` (read everywhere, write in the run folder), with this runner's config, the CLIs'
user config dirs, `~/.claude.json` and Codex's home denied outright (read and write), with
wherever a symlink inside them leads, the
session's skill packages readable only, and the run folder's `.codex`, `.agents`, `AGENTS.md`
and `AGENTS.override.md` read-only. The network is on, as for Claude Code's Bash. Codex's
sandbox enforces the profile on every command the owner hasn't approved. An approved command
may run escalated (Codex lets the agent ask for it, and its approval request doesn't say so):
it can then write anywhere but the denied paths, as an approved Bash command can for Claude
Code. A session whose
`thread/start` doesn't report that profile active is refused before any turn ("remove
sandbox_mode from ~/.codex/config.toml"). Every command Codex doesn't know as read-only asks
the owner; "always allow" lasts for the session and never adds an execpolicy or network rule.
Input for a running terminal (`writeStdin`) and a command Codex doesn't name are declined.
A second approval for one command (Codex's "retry without sandbox?") and a command asking for
more permissions are declined without a question, as is every request for more permissions.
File changes outside the run folder, into its Codex config or instructions, or into the
machine's config are declined without a question; others ask, each one. The agent's questions
become choice questions (one with a secret is never asked); MCP elicitations are declined, but
Codex's approval before an MCP tool call, which asks the owner each time.
Skills load as extra skill roots: call one as `$<skill>`. With `allowBypass`, a
`bypassPermissions` session runs on Codex's `:danger-full-access`. Approval policy stays
`untrusted`; the runner automatically approves native commands and valid file changes.

MCP servers: a session gets the MCP servers its agent's tools name. A runner tool is one of
`mcpServers` above; an unknown name ends the start with an `error` before any folder is made.
An HTTP one comes with its headers: Claude Code gets them over the SDK's control channel
(`setMcpServers`), never on its command line, and Codex as variable names
(`env_http_headers`), their values only in its app-server's environment and never in shells.
Codex has no SSE transport: an SSE server in a Codex session is refused. A server that doesn't
connect ends the session before its first turn. A runner tool's server starts from your home
folder, never the run folder (where the agent could plant an `.npmrc`). Managed Job tools follow
the agent's per-action permissions in every session mode: Run actions proceed, Ask actions ask
each time, with an option to remember the permission for the agent. Other MCP tools ask each
time outside `bypassPermissions`. Codex servers use `default_tools_approval_mode: "prompt"`
so read-only hints cannot skip these checks. Listing a runner tool's actions (`tool.discover`, from Settings → Tools) starts its
server from your home folder with an MCP client's default environment plus its `env`, its
stderr dropped, and stops it again (at most 30 s); its `env` values are redacted from the list.
Runner action denials in protocol 18 are enforced before automatic grants, bypass, or owner
approval. Codex removes initially denied actions with `disabled_tools`; Claude gets exact
`disallowedTools` names and also refuses them in its hook and permission callback. Claude
normalizes punctuation to underscores; actions sharing an alias are blocked together when
either is disabled. Codex keeps server-local action names unchanged. Live updates
can add denials or remove a whole server, but cannot restore access in that session. An answer
that arrives after an action is disabled cannot authorize it. Restrictions received while
skills load are applied before the native MCP configuration is built. Re-enabling an action
requires a new CLI session; a call already executing is not cancelled by these updates.

A poll's call (`tool.call`) starts the server the same way, outside any session, and calls the
action only if the server marks it read-only (`readOnlyHint`) or your `pollable` lists it,
whatever Dispand asks; one call per tool at a time, at most 30 s, its `env` values and the
runner's token and every value in the runner's and the CLIs' credential files redacted from
the result, however the server reached them. A call whose arguments name the runner's config or
a CLI's home (as a path, `~/…` or a file URL, or through a link) is refused before the server
starts.

## Commands

- `DISPAND_PAIRING_CODE=<code> node main.mjs pair [--config <dir>] --server <url> --root <dir>...`: checks everything locally
  first (roots, config dir, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`), then trades the single-use code for a token
  and saves both atomically.
- `node main.mjs run [--config <dir>]`: on SIGTERM or SIGINT it aborts its live CLIs without
  reporting errors (Dispand resumes them once the runner is back), writes every event to
  the backlog and exits, within 10 s. It connects (while Dispand is unreachable, events
  wait; past 20,000 of them or 32 MiB, sessions end with an error and none starts until the
  backlog drains below half) and runs sessions (what the unit starts). Logs: `journalctl --user -u dispand-runner`.

## Development

`pnpm --filter @dispand/runner test`; `pnpm --filter @dispand/runner build` writes
`dist/dispand-runner.tgz` and copies it, with `install/install.sh`, to
`apps/web/public/runner/` (gitignored), which the web app serves. From the source:
`node apps/runner/src/main.ts run`.

### Native plugins and workspace skills (protocol 24)

The runner package includes [Skillshare](https://github.com/runkids/skillshare) v0.30.6
for Linux x86-64 and ARM64. No separate installation, initialization or updates are
needed. Each runner build downloads the pinned release archives, checks their SHA-256
against `skillshare-release.ts`, and includes the executables and MIT license. The
runner invokes its bundled executable by absolute path; a system Skillshare is never
used. Updating the runner replaces Skillshare with the version tested for that build.
`build.json` records the version, and changing a release pin changes the runner build id.
The runner tests exercise the real pinned executable's inventory, preview, stale-revision
refusal, install and removal contracts against isolated native client fixtures.

Native plugin management remains a local opt-in. Select **Enable native plugin installation**
when adding a runner, then run the displayed installer command. For an existing runner, run
its installer once on the machine with `--update --native-plugins`. Source installs can use
`node main.mjs native-plugins --config <dir>` and restart the runner. Ordinary updates preserve
the choice and never enable native management on their own. The installer saves
`"pluginTargets": "managed"` locally; the server and agents cannot set it.

Once enabled, the runner maintains `skillshare/config.yaml` under its own config directory.
It uses the built-in `claude` / `codex` targets for default CLI homes, and named
`dispand-claude` / `dispand-codex` accounts for custom `CLAUDE_CONFIG_DIR` / `CODEX_HOME`
paths, matching the accounts sessions use. Its plugin
declarations survive restarts and runner updates. The personal Skillshare configuration
is not changed. Native installation still requires an owner-only preview and explicit
approval of the whole plugin in Dispand; importing workspace skills alone installs nothing
natively. A missing or unsupported native CLI remains unavailable.

To disable native management on a runner, remove `pluginTargets` or set it to `{}` in its local
`config.json`. An explicit nonempty target map retains the advanced configuration:
its values name accounts in the operator's own Skillshare configuration (or
`SKILLSHARE_CONFIG`), as before. Those accounts must use the same config directories as
sessions, outside every runner root. The runner still uses its bundled executable.
Re-pairing preserves explicit target choices. A runner started from source needs
`pnpm --filter @dispand/runner build` first to prepare the bundled executables.

The owner-authenticated `runners.plugins` API accepts `list`, `discover`, `add`,
`add-workspace` and `remove`. These operations are not management tools and reject
Job contexts. The workspace-bound `runners.workspacePlugin` API resolves the owner's resource and `harnessIds` (one or two on the same runner), so browsers supply stable ids rather than source URLs. Uninstall remains scoped to one harness. Discovery accepts credential-free HTTPS Git sources, optionally with
`sourceRef`. Add selects one explicit marketplace `plugin`, a logical `name`, and
one or both CLI harness kinds on that runner. Every mutation first uses
`dryRun: true`; application repeats the same operation with `dryRun: false` and its
preview `revision`. Skillshare refuses stale revisions. Targets become repeatable
`--target` arguments, with explicit global scope; only the runner’s managed or locally
overridden targets can be changed. See [Skillshare's command reference](https://skillshare.runkids.cc/docs/reference/commands/plugin/).

**Add/remove affects the whole native plugin**, including its native hooks, commands
and MCP integrations, not just a skill. Native removal keeps Dispand's workspace
plugin and skill copies. Skillshare manages only its own bindings; other native
installs are not adopted. Inventory reports registration, enabled state when known,
and pending operations; registration alone does not prove resources loaded in a
session. Local paths, native error messages and credentials are never returned.
Native failures, partial success, timeouts and stale revisions require refreshing
inventory and an explicit new decision; Dispand does not retry or fall back after
execution. One operation runs at a time per runner, capped at two minutes.

The plugin install sheet optionally selects locally enabled runner / harness pairs.
The initial Install click approves those targets and imports workspace components once.
The sheet then previews and applies one combined native operation per runner using its
revision, without another confirmation. Each selected harness shows Installing, Installed
or a failure; known existing installations are kept. A failed native step leaves the
workspace import intact; use
the Harness page's inventory to refresh, remove or retry, without reinstalling the
workspace plugin. Multiple named harnesses of one kind on a runner share its native
account. Native-only installation can register a source without importing components.

The Harness page groups plugin-backed workspace skills under their whole plugin,
with install/uninstall actions, and also offers standalone workspace packages.
Standalone files become a skills-only plugin under the runner state directory at
`native-skills/<native-name>/<digest>/<native-name>/`; paths and frontmatter use the
session writer's rules. Skillshare manages its complete native lifecycle. Sources
persist for reinstallation; Dispand does not edit native client registries itself.

At each start/resume, only a matching, installed, known-enabled native binding on
that session's harness suppresses the stripped workspace package. New installations
use stable workspace ids; matching uses the repository URL/resolved commit/entry,
or the standalone content digest. Renaming an item does not change its identity. Changed
content, account context, missing/disabled bindings and inventory errors keep the
workspace copy. Native runtime errors never retry with the stripped copy. Trust,
authentication and harness reloads still happen in the native client.

The Skillshare v0.30.6 lifecycle and binding fields were verified against its
[official command reference](https://skillshare.runkids.cc/docs/reference/commands/plugin/)
and [maintained implementation](https://github.com/runkids/skillshare/tree/main/internal/plugin).
Sources without a compatible native manifest, unsupported formats and source
selection conflicts are reported by the native preview; they keep workspace skills
available. Existing Skillshare-managed bindings also match by their verified pinned
source, irrespective of logical name. Unmanaged native installations with no
verifiable source identity are not guessed or adopted.

Native workspace imports may live at the repository root or in a marketplace subdirectory.
For subdirectories, the runner checks Skillshare's selection at the imported commit for each
requested harness before preview and apply. A Git subdirectory that is not selectable by the
same plugin name in that repository's marketplace is refused. Update older workspace imports
with no recorded folder before installing them natively. Source matching includes the selected
folder; discovery failures keep workspace skill fallback enabled. Immutable source discoveries
are cached in memory (up to 200 sources) to avoid repeated Git fetches during inventory polling.
Protocol 24 requires updating runners along with the server.

## Updating from Settings

Settings → Harnesses → Runners shows **Update available** when an installer-managed runner's
build differs from this server's downloadable build. Open the runner and choose **Update
runner**. It runs the existing `install.sh --update` in a transient systemd user unit, keeps
local configuration and pairing, then restarts; live sessions resume on reconnect.

Updates are requested explicitly, never installed automatically. The small authenticated
update control channel is independent of the session protocol, so a runner can update even
when its session connection is refused as outdated. Requests are held in memory: if the
server restarts before delivery, click again. A failed update can be retried; local diagnostics
are in `journalctl --user -u dispand-runner-update`.

Runners installed before this support need the manual update command once to gain it.
Manually launched runners keep using the manual installer command. Development builds must
run `pnpm --filter @dispand/runner build` to supply the downloadable build and its identity.
