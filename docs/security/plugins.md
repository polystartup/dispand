# Plugin and skill authors, to the server and runners

- **Skill files never name a path outside their skill.** Every file of a skill package, made in
  the app or imported from a plugin, passes `isSafeRelativePath` (`packages/runner-protocol/src/paths.ts`)
  before it is stored: relative POSIX paths only, no `..`, `.` or empty segment, no `\`, NUL or
  other control character, and no `.claude` or `.mcp.json` segment (in any case), which the
  runner's boundary treats as the CLI's config. The runner checks every path with the same
  function again before it writes anything.
- **Skill files reach a session readable, never editable, and outside every work folder.** A
  runner gets a package from `GET /runner/packages/<id>` with its own token, and only one an agent
  on that runner uses (an agent whose harness is on that runner has it; 404 otherwise). It fetches before
  making the run folder, over the server URL its config allows, with no redirects and a capped
  body. It writes only `<plugin>/.claude-plugin/plugin.json` (its own `{ "name" }`) and
  `<plugin>/skills/<path>`, never a package's hooks, commands or MCP servers. Every skill folder, and the
  folder of any `SKILL.md`, must be lowercase words joined by single hyphens (else the package is
  refused). Every `SKILL.md` (at
  any depth) is written with the runner's own frontmatter, holding only `name` (its folder) and
  `description` (`canonicalSkillMd` in `apps/runner/src/skills.ts`). No other key (hooks,
  allowed-tools, model...) reaches the CLI, however the original is written: what the runner
  can't read stays as body text under its frontmatter, which can't end early (the description is
  one line with no `---`). Every `@` in the file becomes `＠` (U+FF20), so no file mention is
  expanded outside the read checks, whatever surrounds it. Every session runs
  with `disableSkillShellExecution`, so no skill or command runs a shell command as it loads. The files go under
  its state dir (`$XDG_STATE_HOME/dispand-runner`, else `~/.local/state/dispand-runner`,
  which may neither overlap a root nor the machine's config: checked when the config loads), in
  `sessions/<hash of the session id>/plugins`. Every file is created with `O_EXCL|O_NOFOLLOW`, then
  made 0444, and its folders 0555. Edits there are denied by the boundary (outside the working
  directory); reads are allowed. The SDK loads them with `skipMcpDiscovery`. They are written
  again at every start or resume and removed when the session ends and when the runner starts,
  so a changed copy never outlives its session.
- **Native plugins are an explicit runner-local opt-in.** The owner-authenticated `runners.plugins`
  and `runners.workspacePlugin` procedures check runner ownership and CLI harness membership. They
  reject Job contexts and are absent from management tools. Protocol 15's native requests run only
  the runner's bundled Skillshare executable by absolute path, from its home directory, with
  explicit global scope. Runner builds pin the upstream version and SHA-256 of each Linux release
  archive and ship its MIT license; dependency changes alter the runner build identity. Runtime
  never downloads or upgrades a dependency independently. The local installer’s `--native-plugins`
  option saves `pluginTargets: "managed"`; ordinary updates never enable native management.
  Absent targets or `{}` disable it, and explicit maps retain operator-configured accounts.
  The server and agents cannot change this local authorization. Once opted in, targets are managed
  accounts in the runner's own protected config directory, bound to the same local CLI homes as sessions.
  Personal Skillshare configuration is not edited. The server cannot set commands or account
  config paths. The runner installation directory, including bundled executables, is excluded
  from session roots. Complete plugin sources are credential-free HTTPS Git URLs, pinned to the
  workspace source commit and entry identity; no server-selected local paths or other transports.
  Protocol 24 carries the imported repository-relative folder for subdirectory plugins. The
  runner verifies Skillshare selects that folder for every requested harness before preview
  or apply. Source matching includes subdirectories and uses Skillshare discovery of the
  binding's immutable commit; failed discovery cannot suppress workspace skill fallback.
  Standalone workspace packages use `add-workspace`: bounded package-relative files, staged
  atomically under the runner state directory at
  `native-skills/<native-name>/<digest>/<native-name>/`. The session writer checks paths and
  rewrites frontmatter, producing only a skills directory and its own manifest. The staged source
  persists for Skillshare's reinstall lifecycle; it stays outside roots and cannot change CLI
  settings. Mutations select explicit targets and require a preview revision. Complete native
  plugins may execute their native hooks, commands and MCP integrations: the owner approves that
  native lifecycle by selecting its targets and clicking Install after the whole-plugin warning.
  The sheet then previews and applies that selected scope without reconfirmation; Skillshare’s
  revision check still rejects changed state. Workspace imports and native execution remain separate.
  Skillshare config, data and state directories join the machine paths excluded from roots and session access. Custom
  account config directories must be outside roots and protected locally like CLI homes. Native
  replies expose a bounded projection, never raw paths, identifiers or error text. One operation
  runs at a time, with bounded output and time; failures and partial outcomes are reported, never
  automatically retried. Removing a native binding does not change workspace imports. Registration
  does not imply successful resource loading. On each start/resume the runner omits a workspace
  package only for a matching source key associated with its workspace entry: repository URL,
  resolved commit and entry, or the standalone package content digest. The native binding must be installed,
  enabled and free of pending operations or changed account/source context on that session's
  harness. Missing, disabled, unknown, mismatched or unavailable native inventory retains the
  stripped workspace copy. Native execution failures never trigger automatic fallback or retries.
  A locally overridden Skillshare target must name the same CLI account sessions use.
- **In the container runner, a native plugin runs in a conversation only when its agent holds a
  grant for it.** A workspace manager grants an agent native plugins (`agents.setNativePlugins`),
  never a member or a Job, even an approved one's, and each grant is an Audit row (ids and a
  count). Grants are separate from skill packages, and are read at each start and resume
  (`engine/tooling.ts`): a restricted Job gets none, and a plugin removed from the workspace takes
  its grants with it. A start names each granted plugin by the digest of its native revision:
  the whole plugin as an install or update read it (`plugin_native_files`), moved only by a
  person with the manager role or by a Job's proposal item a person approved (`movesNativePin`):
  a Job's own install or update never moves it, whatever its person's role; a plugin with no
  revision kept (too large, or imported before revisions were kept) is left out. The pin moves
  only after a screen that showed what the revision runs natively (`plugins/native-code.ts`): the
  install, update and approve-native screens, and a Job's proposal item that installs a plugin
  (the install's token covers the revision it showed), list its hooks, its stdio servers' launches
  (environment names, never values) and the files they run, and an update or approval shows them
  against the pinned revision with every other changed file (markdown no hook or server names by
  path only, since its text is on the screen's other sections). Any change to the native revision
  makes an update stop on its screen, and the screen's token covers the whole revision, so one
  that moved since is refused. A runner gets
  a revision's files (`GET /runner/native-plugins/<plugin id>?digest=`) only while one of its
  agents, by its harness, holds a grant for that plugin in the plugin's workspace and that digest
  is still the pinned one, checked at each request. The supervisor keeps a revision under
  `<state>/native-plugins/<digest>` only after checking its files against the digest the start
  named (caps, safe paths, then the digest), written whole and read-only. Its safe paths are a skill
  package's, plus the plugin root's own `.mcp.json` (`isNativePluginPath`): a native revision is
  only ever the plugin's own read-only folder, never a workspace's; the store is cleared at
  each start. A worker mounts its conversation's plugins read-only at `/run/plugins/<plugin id>`,
  and nothing else of the store (`sandbox/native-plugins.ts`). A start names each plugin's
  servers Dispand manages as tools (protocol 39, `managedServers`): at each start the supervisor
  derives, from the unmodified stored files, the session's own read-only view of the plugin with
  those servers' declarations left out (`.mcp.json`, `mcp.json`, a manifest's `mcpServers` and the
  files it names), and a manifest references only files the filter wrote. That filter is a first
  layer; the guarantee is the check at use (`managedLoaded`): once a CLI has started a session
  (Claude Code's init message, Codex's `mcpServerStatus/list`, before its first turn), a server
  it reports loaded from a native plugin that is one of that plugin's managed servers stops the
  session before any turn, so only the relayed copy of such a server is ever used. Codex's copy,
  with its paths filled in, is held to the store's own size cap. The view also leaves out every hook that
  could answer for a permission (`PreToolUse`, `PermissionRequest`, in any case, wherever the
  plugin declares hooks), and drops whole a hooks declaration of a shape it doesn't read for sure:
  a plugin's hooks run in the worker, but never decide a permission, which stays the broker's.
  Every markdown file of the view keeps only the frontmatter that grants nothing (`name`,
  `description`, `argument-hint`), its body as it is, and one whose frontmatter can't be read is
  dropped: a plugin's skills, commands and agents never pre-approve a tool (`allowed-tools`),
  declare hooks or pick a model or a permission mode. A plugin's own MCP tools ask the owner
  whatever the plugin says of them (`readOnlyHint` or any other annotation): Claude Code through
  Dispand's hook, which answers `ask` for every MCP tool not of the agent's or the Job's servers;
  Codex, which runs a tool labelled read-only unasked otherwise, through the thread's own config
  the supervisor sets (`plugins.<plugin>.mcp_servers.<server>.default_tools_approval_mode =
  "prompt"`), with Codex's copy of each server declaration reduced to how it starts, so no
  approval setting of the plugin's overrides it. Claude Code loads each view
  whole through the Agent SDK's per-session plugins. Codex installs each view, before the first
  turn, from a marketplace the supervisor writes read-only beside them (`codexMarketplace`,
  `codex/native-plugins.ts`). Codex runs no hook from that install or from its home: the
  supervisor writes the conversation's Codex requirements (`writeCodexRequirements`), mounted
  read-only as Codex's system configuration (`/etc/codex/requirements.toml`), which allow managed
  hooks only and list exactly the plugins' command hooks, never one of an event that can answer
  for a permission (`PermissionRequest`, `PreToolUse`): approving the CLI's actions stays the
  permission broker's alone. Hook trust never comes from the worker's writable Codex home, so a
  hook or a trusted hash a command writes there runs nowhere (checked with Codex 0.169). Codex's own manifest (`.codex-plugin/plugin.json`) is filtered like
  the others, and names the plugin when present. In Codex's copy, `${CLAUDE_PLUGIN_ROOT}` and
  `${CLAUDE_PROJECT_DIR}` in its server and hook declarations become the plugin's read-only mount
  and the session's folder (Codex doesn't expand them); `${CLAUDE_PLUGIN_DATA}` stays literal.
  Claude-format agents (`agents/*.md`) don't run on Codex. A restricted
  session gets no plugin on either CLI. In the image the grant alone is enough, with
  no local opt-in: the plugin's hooks and servers run inside the conversation's worker, which
  holds none of the runner's credentials, tools or other conversations. The bare install keeps
  the record below.
- **A runner runs a plugin's code only when its own record matches.** `allowedPlugins` in the
  runner's config, written on the machine only (`dispand-runner allow-plugin`, or by hand) and
  out of the server's reach like `mcpServers`, holds per plugin name the content digest and the
  launch entry. `allow-plugin` doesn't take the tool's page on trust: it fetches the files over
  the runner's token, refuses another name or a digest other than the one typed, shows the entry
  and writes only after a typed yes. Before a launch, `pluginLaunch`
  (`apps/runner/src/plugin-servers.ts`) recomputes the digest over the files it was given and
  canonicalizes the entry it was sent; with no record of that name, or a digest or entry other
  than the record's, it refuses before writing anything, so a label from the server proves
  nothing. It then writes the files read-only outside every root and the machine's config,
  runs a `./` command only when its real path is a file inside the plugin, keeps `cwd` inside the
  plugin or its data folder, and expands only `${PLUGIN_ROOT}` and `${PLUGIN_DATA}`, once, in
  `args`, `env` values and `cwd`. The record proves the plugin's files and its command line, not
  what that command downloads when it runs (`npx some-package`): `allow-plugin` says so whenever
  the command isn't a file of the plugin, and so does the tool's page. Dispand delivers such a
  server as a runner tool (protocol 30): a `plugin` reference (tool id, plugin name, digest,
  entry) in a session start, `tool.discover` or a poll's `tool.call`. The runner checks the
  reference against its record first, then launches the folder it already wrote for that digest
  (named by the digest it computed over what it wrote) or fetches the files
  (`GET /runner/plugins/<tool id>`, its own token, a plugin runner tool on that runner only, no
  redirect, 16 MiB) and recomputes their digest. A session's CLI starts it behind the runner's
  MCP proxy, as any runner tool; a poll calls only what its server marks read-only, and paths in
  a poll's arguments are resolved from the plugin's working directory for the runner's guard.
- **Workspace plugin imports bring files, never code that runs.** Marketplaces and plugins are fetched with
  `fetchGit` (`packages/domain/src/plugins/git.ts`): `https://` only (no credentials in the URL;
  `file://` only in a development build with `DISPAND_GIT_FILE_URLS=1`, for e2e fixtures),
  redirects not followed, no prompts, hooks, submodules, LFS or system and user git config,
  60 s and 200 MiB on disk at most (a limit kills git's whole process group), into a temp folder removed afterwards. A plugin in the
  Agent Plugins layout (a root `plugin.json`) is read with that standard's rules. A schema-less root object may use the Claude loader when a named Claude manifest exists; explicit schemas never fall back. Both loaders run under the same
  limits: its `$schema` ids are known, never fetched; a linked `plugin.json` rejects it; its
  stdio servers are read (a `./` command and `cwd` that stay inside the plugin, or a `cwd` in
  its data folder). Dispand runs none of a plugin's commands itself; it keeps a standard plugin's
  files when it has a stdio server (`plugin_files`, at most 500 files and 11 MiB, so their base64 fits the runner's 16 MiB response cap; a larger
  plugin installs keeping none, and its stdio servers can't be added; links, `.git` and paths a
  runner can't write left out and listed), and a runner runs such a
  server only as the paragraph above says. A plugin in the Claude layout keeps none: its stdio
  servers are added from a runner's own `mcpServers`, as today. Its `com.dispand`
  definitions (tables, agents, triggers) are data and grant nothing: install only stores them,
  each read as a regular file within the same budget and checked alone. What is made from one is
  made by the procedure a direct call uses, by the owner or through an approved proposal, with
  that procedure's checks. The owner's setup (`plugins.setUp`) makes the items a proposal would
  list, each through its procedure with the owner's own session, and binds to what an earlier
  setup made only by the id it recorded, never to a table by its name. An agent made from a
  definition is the plugin's element, made by `agents.create` with the bundles, tables and
  self-learning the owner reads in the item, so its consults pass the same pair check as any
  agent's. That a row is a plugin's is set only by the server (`context.pluginElement`, which no
  request input reaches); an update shows, before applying, every change that
  gives an agent more or moves a tool's calls, every change of what an agent is told, and every
  field of the owner's the plugin changed; it applies only what was shown (`reviewed`), through
  each element's own procedure, and never replaces an overridden field unasked. A tool it gives
  an existing agent starts with every action on Ask, whatever its server calls read-only. What a
  new version adds is made by no update: only by a setup, whose items show each grant. A plugin's HTTP server becomes a tool only through `plugins.addServer` (or its setup
  item), with no credentials and only at the URL and transport the owner reviewed in the item; a
  stdio server only as a runner tool on one of the owner's runners, with the digest the owner
  reviewed in the item, and it runs nothing until that machine's record allows it. Links are checked out
  as plain files (`core.symlinks=false`), then removed from the checkout and listed as not
  imported: nothing is ever written or read through one, and a file name that isn't UTF-8 refuses
  the fetch. Every file is read with `lstat`, any other non-regular file is skipped, and a plugin or skill folder whose real path leaves the
  repository is refused. An install imports only the components the owner ticks: skills, each
  through `validatePackage` (so `isSafeRelativePath`); agents, as a system prompt on the harness
  the owner picks (the agent file's `tools` and `model` are ignored); and HTTP MCP servers, as
  HTTP tools. An imported agent or tool is the plugin's element: an owner's change of one of its
  fields is an override made by the element's own procedure, with its checks, and an update of
  the plugin never replaces an overridden field. A reset to the plugin's value goes through that
  same procedure, so a tool sent to another origin, by an override or by a reset, loses its saved
  headers and sign-in. An uninstall applies only what its preview showed (`reviewed`) and the
  choices the owner made, checked as a whole on the server: nothing a kept element uses is
  removed without a stated choice, and both procedures need an owner session. A file of a
  plugin's skill the owner writes goes through `validatePackage`
  with the whole package, as an upload does: no path leaves the package, and the caps hold. A server is unticked until the owner ticks it with its URL shown, and is imported
  only as reviewed (its definitions at that commit, marketplace manifest included, else
  `CONFLICT`). Its `${VAR}` placeholders are filled from the owner's settings at install, then
  each header is sealed, and so is the whole URL when it holds one (shown as its template). A
  URL setting may fill only the path or query (never the scheme, user, host or port, which a URL
  rewrites) and hold only letters, digits and `. _ ~ -`, so the server sees it exactly as typed
  and it is redacted from what the server sends back like a header value. Settings elsewhere in
  a URL are out of scope: such a server is refused. Every insert path checks a tool against the
  same rules as the form (`insertTool`). Hooks, commands, `bin/`, MCP servers that run the
  plugin's own files (`${CLAUDE_PLUGIN_ROOT}`) and, until runner tools exist, MCP servers that
  run a command are never stored or run; all but the last are listed as not imported. A
  plugin's foreign keys never cascade into the owner's data. The owner's explicit removal
  checklist can delete only packages, tools and agents currently owned by that plugin. Selected
  skills and tools are unlinked from kept agents and skill requirements; workflow tool references
  still block deletion. Assistant and workflow agent guards remain enforced, and selected agents
  go through `Engine.deleteAgents` so their Jobs and history remain. Unticked components are
  detached and kept. Native removals use the runner's reviewed, account-scoped lifecycle before
  workspace removal; partial native success is shown and never retried automatically. Generated
  plugins do not own their listed business data, which removal keeps. Older calls without a
  checklist keep agents/tools and delete only unused packages. No foreign key to `plugins` cascades to
  the owner's data (`db/cascades.test.ts`). Updating a plugin moves its tools to a new
  URL only within the same origin, so saved headers never go
  to a host the owner didn't pick. Reading a plugin has one budget that every listing, read, MCP server and not-imported note
  is charged to (20,000 items, 64 MiB read; at most 200 skills, 100 MCP servers and 100 agents),
  so no shape of repository or manifest makes it do more. A plugin's skill package is read-only while the plugin is installed. Errors name what failed
  in a few words, never git's output.
- **Skill sites are read over https only.** A `.well-known` skill site's index and files are
  fetched with no credentials, redirects followed only to the same origin, within 1 MiB for the
  index, 2 MiB per file and 32 MiB and 60 s per read. A skill whose name isn't a skill name, or
  whose files include a path `isSafeRelativePath` refuses, is listed as not imported, and its
  files are never requested. Every other skill goes through `validatePackage`.

Native installation identity records the resolved Git root at import and update. Only verified
root plugins currently support native installation; older imports must be updated, and nested
plugin imports keep their workspace skills. An explicit native-install intent requires the
preview review token even when workspace components are also selected. Codex's local plugin
cache, marketplace code and skills directories are readable in its sandbox; its parent config
directory, settings and credentials remain denied, and native code is never writable by the session.
