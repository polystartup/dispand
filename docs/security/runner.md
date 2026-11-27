# The server and a runner

- **Runners authenticate with a revocable token**, never a session. The token (32 random
  bytes) is shown once to the runner and stored as SHA-256; a pairing code is single-use,
  expires after 15 minutes and is stored as SHA-256 too. `POST /runner/pair` is public and
  answers the same 401 for unknown, used and expired codes, and reads at most 1 KiB of body
  (413 past it); every request body is capped at 1 MiB by the production server (11 MiB for
  `files.upload`, `skills.create` and `skills.update` only; a body without a length is refused). A runner is bound to its workspace before pairing.
  CLI job placement and runner access to job attachments and agent skills check this binding.
  An upgrade with conflicting legacy runner placement waits for an explicit database administrator
  assignment. Existing bearer tokens and pairing codes keep their values.
  Revoking a runner clears its token
  and closes its connection, and an upgrade still in flight is refused. A runner's
  frames are capped at 1 MiB, and its connection is closed past 1000 messages or 8 MiB waiting
  to be handled; every protocol string, list and record has a maximum. A paired runner is the
  owner's own machine: these limits contain its mistakes, not a hostile runner, which the owner
  revokes. A runner older than the server's protocol is refused (426) only once its token is
  known, and a `tool.discovered` reply only answers a request sent to the runner that replies. A runner's events only reach the sessions the engine started on that runner; events
  for any other session are ignored. The pairing code travels in the environment
  (`DISPAND_PAIRING_CODE`), never in a command line other local users could read. Tokens
  and codes are never logged, and logs carry no error text, only its kind and
  Postgres code.
- **The runner does not trust the server blindly.** Its config on the machine, which the
  server can't change, decides where sessions may run: only in fresh per-run folders the runner creates,
  `<roots[0]>/runs/<runKey>` (refused if it exists; no symlink on the path from the root:
  `runs` is a real directory and the folder's real path is exactly `<root>/runs/<runKey>`; only resuming reuses a folder, and only for a CLI session id the runner itself recorded for
  that run key, in its state dir, mode 0600), and whether `bypassPermissions` is allowed at all
  (`allowBypass`, off by default). Claude Code always gets
  `disableBypassPermissionsMode`: the runner implements native command/file bypass through its
  approval broker so managed MCP calls cannot skip their per-agent permission checks. Unresolved
  file paths still ask the owner. Sessions load the user's own Claude Code settings only,
  never a run folder's `.claude/` settings, hooks, `.mcp.json` or `CLAUDE.md`, on start or
  resume. Claude Code and Codex run as the runner machine's user, with that user's own profile:
  its settings, instructions files, memory, hooks and sign-in. Agents on that runner therefore see
  and use that profile, and whoever pairs a runner chooses that user.
  The server URL must be `https://` (plain http only to
  loopback), in the config, `pair` and `install.sh` (`--update` takes it from `config.json`,
  which it never changes, and checks it the same way).
- **A file attached in a chat reaches only that chat's agent, and never as configuration.** The
  owner attaches files in any chat (`files.hold`, owner-only, refused to a Job, not a tool): each
  is held for them (no table, no Job), counted in the organization's total from then on, removed a day
  later if no message carries it. `runs.sendChat` gives the files it names to the message's Job
  in the transaction that writes the message (`takeChatFiles`: the owner's held files only, all
  or none, within 20 files of 10 MiB and the Job's totals, under the Job's files lock); a Job
  can't name any (`FORBIDDEN`). A cloud model gets them as image, PDF or text input, read from
  disk at each model call and never stored in its transcript; a PDF's pages are read by pdf.js in
  a child process with no environment, a 96 MB heap and 5 seconds, never in the server's own. A CLI session gets each one copied
  by its runner to `.dispand/attachments/<attachment id>/file<.ext>` in the run folder, every part
  made by Dispand (the original name gives only its extension, letters and digits); the original
  name is words in the message, never a path. Both the server (before it names a path,
  `chatFiles`) and the runner (`session.send`'s schema, then again before writing,
  `apps/runner/src/attachments.ts`) refuse a path that isn't `isAttachmentPath`: so never a
  `.claude`, `.codex` or `.mcp.json` segment nor a `CLAUDE.md`, `AGENTS.md` or
  `AGENTS.override.md` (in any case), which a CLI would read as configuration or instructions.
  The runner writes only through a `.dispand` and folders below it that are real folders, and
  creates each file from inside its folder (a child process that `chdir`s there and checks its
  real working folder first), so a live session swapping a folder for a link meanwhile sends the
  write nowhere else; files are created `O_EXCL|O_NOFOLLOW` and made read-only by descriptor. It fetches the bytes at `GET /runner/attachments/<id>` with its
  own token, which serves only a file a chat message carries, of a Job with a session on that
  runner. The child that writes gets no environment.

### Runner updates

Installer-managed runners poll the authenticated `/runner/update` control channel independently
of the session protocol. Only the signed-in owner can request an update of their runner.
An update executes the existing installer from the runner's locally configured server (no
redirects), in a transient systemd user unit so it survives restarting the runner. The server
cannot supply a command, URL or local configuration through the update request. As with the
initial installation, the configured Dispand operator is trusted to supply runner code.
