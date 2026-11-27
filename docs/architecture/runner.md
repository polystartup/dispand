# The runner

- **The runner:** a Node service run as the machine's user by the systemd user unit
  `dispand-runner.service`. `Connection` dials `/runner/ws` and pings it every 25 s (WebSocket
  ping frames, which `ws` answers on the hub; neither side takes them for protocol messages),
  ending a connection that read nothing since the last ping (part of a frame counts: a big one
  holds the pong up behind it). A frame the runner sends holds the pong up as well, and its
  upload can't be seen: one up to 1 MiB must reach the hub within 25 to 50 s (about 21 to
  42 KB/s), or the connection is ended; an event that big, resent first, then ends each
  connection the same way while the link stays that slow. It dials again after a random wait up
  to 1 s, doubling up to 30 s until a connection catches up: an event numbered past its
  `hello`'s `lastSeq` is acked (the hub handles nothing past `lastSeq` before its caught-up
  handler is done), or a ping is answered (all an idle runner can go by). A hand-off (close 4002
  or 1013) or a 503 at the upgrade is followed by a wait up to 1 s each time. It numbers
  events with a seq kept in `state/<runnerId>/state.json` (per pairing, like the backlog and
  `sessions.json`: a re-pair only rewrites `config.json`, then removes other pairings' state;
  any safe integer; the hub stores seqs as `bigint`),
  keeps unacked ones in `backlog.jsonl` (append-only, compacted as acks come, replayed after a
  restart) and resends them after `hello`, oldest first,
  keeping at most 500 events and 4 MiB in flight (half the hub's limits). While events wait,
  consecutive text deltas of a session are coalesced (up to 32k characters each, never across a
  new assistant message's first delta), and while a
  session has a text event not acked yet, its new text waits without a seq and goes out as one
  event once that one is acked, at most 1 s later, once it reaches 32k characters, or right
  before the session's next other event (as cloud sessions' `textStream` does): a slow server
  gets one text event per session per round trip, not one per streamed delta. Past 20,000
  events or 32 MiB waiting, every live session ends with an `error` ("Dispand unreachable"),
  only errors are kept, and no session starts until the backlog drains below half. Every event goes
  through `protocolEvents` (`apps/runner/src/sanitize.ts`) first: NUL and lone surrogates become
  U+FFFD, strings are cut to the protocol's maxima and long text deltas split, each event
  within a 1 MiB frame. Then every frame, the hello and replies included, is parsed as the hub
  parses it before it goes: one the hub would drop (unacked, so sent and dropped again at every
  reconnect, which can keep the connection from turning ready) isn't sent. An event gets no seq
  and its session an `error` instead, a reply isn't sent (the server's request times out), and
  the hello connects again; the runner logs which field failed, never its value. Outputs are never cut: `submit_outputs` refuses oversized values back
  to the agent; nor are permission prompts: a tool input too large to show whole is denied
  without asking. `Sessions`
  starts each `session.start` in a fresh per-run folder from `resolveWorkdir`
  (`<roots[0]>/runs/<runKey>`; `SessionStart.cwd` has no other mode) through `startClaudeSession`: the Claude Agent SDK's `query` in streaming-input mode,
  running the machine's `claude` with the user's settings only (`settingSources: ["user"]`,
  never the run folder's), resuming only a CLI session the runner recorded for that run key
  (`sessions.json`). It logs one line when a session's CLI starts and one when it ends: the
  session id, the run key, the harness and the outcome, never a prompt, result or error text.
  A session that fails (`failure.ts`) reaches Dispand as a sentence for the kind of failure
  (its start, Claude Code, Codex, a message Codex didn't take, its run folder, a resume with no
  folder), or as the words of a refusal written for Dispand (`Told`: a tool, plugin, skill
  package, memory file or bypass refused, naming only what Dispand sent); the error's own words,
  which may hold host paths, command lines and output, go to the runner's log only.
  Claude Code and Codex run as the runner machine's user, with that user's
  profile (settings, instructions files, memory, hooks, sign-in), which the session's agent
  sees and uses. A chat whose agent calls `submit_outputs` with no expected values completes
  without an owner confirmation, on both native and cloud harnesses. Workflow chats that hand
  values to later steps still ask for confirmation. Old pending empty confirmations remain
  answerable after an upgrade. No protocol change is needed: starts already carry expected outputs.
  Permission prompts and
  `AskUserQuestion` become `question` events; the agent returns its outputs through the
  `submit_outputs` tool of the in-process MCP server `dispand` (for a step outside a chat that
  expects none, the engine leaves its `outputs-accepted` aside and completes the step with the `result` that
  follows, the last message). `bypassPermissions` needs
  `allowBypass: true` in the machine's config. Native approval callbacks stay active: the
  runner automatically approves native commands and permitted file operations, while managed
  MCP actions still follow their per-agent permissions. Claude uses native `default` mode with
  bypass disabled; Codex uses `untrusted` with MCP server approval mode `prompt`, so read-only
  hints cannot skip the broker. `boundary.ts` is the one permission boundary
  every session runs inside: file edits stay inside the working directory, minus any
  `.claude/` and `.mcp.json` in it (and what their symlinks, or the CLI's user settings and
  hooks, lead to), decided from real paths at
  each call by a PreToolUse hook; "always allow" stays in the session. `config.ts` keeps the
  runner's and the CLI's config out of every root and working directory. `install.sh` writes the unit
  where the user manager looks (its `XDG_CONFIG_HOME`, else `~/.config`) and passes the
  runner's config dir with `--config`.
- **A plugin's stdio server on a runner (runner side):** the runner runs plugin code only
  when its own record allows exactly that code. `allowedPlugins` in the machine's config holds,
  per plugin name, the content digest and the launch entry; `dispand-runner allow-plugin <tool
  id> <name>@<digest>` writes it after fetching the files itself (`GET /runner/plugins/<tool
  id>`), recomputing the digest and a typed yes. `@dispand/runner-protocol/digest` (Node only, shared with
  the server, which computes the digest it shows) computes the digest
  (`sha256:` over every file sorted by its path's UTF-8 bytes: path, NUL, length, NUL, bytes) and
  the canonical entry (keys sorted, `env` keys sorted, `cwd` default `./`). `pluginLaunch`
  (`plugin-servers.ts`) checks the record, the digest and the entry before writing anything, then
  materializes the files read-only under `<state>/plugins/<name>/<hex digest>/` (a temporary
  folder renamed into place, so an existing one is complete and reused), resolves a `./` command
  by real path inside that root, keeps `cwd` inside it or `<state>/plugin-data/<name>/` (kept
  across digests), expands `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` once in `args`, `env` values and
  `cwd` only, and sets both last over `env`. A refusal is a `PluginRefused` whose message names
  only the plugin and digests, logged by the runner, and it comes back as the session's error or
  the tool's `actionsError`. `launchPluginServer` takes a `plugin` reference (protocol 30, in
  `McpServerRef` and in `tool.discover`/`tool.call`): it checks the record against the reference
  first, launches the folder it already wrote for that digest, or else fetches the files
  (`fetchPlugin`) and calls `pluginLaunch`. Sessions launch every plugin reference before
  anything else and hand `mcp.ts` the launches, which start behind the MCP proxy from the
  plugin's own `cwd` and `env`; `tool.discover` and a poll's `tool.call` start the launch directly.
- **A plugin's stdio server on a runner (server side):** install and update keep a standard
  plugin's files when it has a stdio server (`plugin_files`, `plugins.digest`; at most 500 files
  and 11 MiB, so their base64 fits the runner's 16 MiB response cap; a larger plugin installs and
  updates keeping none, noted in `notImported`, and adding its stdio servers is refused (`noFiles`); `fs.ts` `readRunnerFiles`), and `components.mcpServers[].entry` holds
  the launch entry. We decided against a launch column on the tool: the entry is read from the
  plugin, so an update that changes it changes the digest and needs a new `allow-plugin`.
  `plugins.addServer` with a `runnerId` and the reviewed digest (or a setup item from a server
  picked with its runner) adds a runner tool with no `runner_tool`, linked by `plugin_id` and
  `plugin_component`. `plugins/runner-servers.ts` `runnerTarget` is the one place that turns a
  runner tool into what its runner is sent: its own server's name, a `PluginServer`, or why not
  (its plugin was removed: uninstalling keeps the tool, which then reports so). Sessions
  (`engine/tooling.ts`), listings (`refreshRunnerActions`) and polls (`tools/poll.ts`) go through
  it, and `GET /runner/plugins/<tool id>` (`pluginForRunner`, its span and
  `dispand.runner.plugin_files`) serves the files to that tool's runner only. The tool's page shows
  the command, the digest, the `allow-plugin` line and, when the command isn't a file of the
  plugin, that the record covers the command line only. A plugin in the Claude layout keeps no
  files: its stdio servers stay runner config entries.
- **Runner distribution:** `pnpm build` bundles the runner with esbuild into
  `dispand-runner.tgz` and copies it with `install/install.sh` into
  `apps/web/public/runner/` (gitignored), so the web app serves `/runner/install.sh` and
  `/runner/dispand-runner.tgz`. `apps/web` lists `@dispand/runner` as a dev
  dependency only so that the runner builds first. The install command `runners.create` shows
  passes `--server` to `install.sh` and the pairing code in `DISPAND_PAIRING_CODE`, never
  in argv.
