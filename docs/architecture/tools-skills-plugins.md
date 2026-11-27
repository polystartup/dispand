# Tools, skills and plugins

- **Tools (MCP servers):** one `tools` table, MCP connector and Settings → Tools serve agents, sessions and Tool steps,
  with a catalog and runner (stdio) tools. A `tools` row (`packages/domain/src/db/schema.ts`) is
  `kind: "http"`: URL, transport (`streamable-http` or `sse`), headers sealed one by one in
  `headers_sealed` (name in lower case → sealed value, AAD `headerAad(id, name, url)`, which names the URL's origin: a header opens only while its
  tool calls the origin it was entered for; `resealToolHeaders` (`tools/reseal.ts`) seals again,
  at server start, a header sealed before that binding, with its tool's origin then), the actions
  of the last listing that succeeded (`ToolAction`: runner-protocol's `McpAction` plus an
  optional `outputSchema`) and `actions_error`, the short reason the last one failed. Names are
  unique case-insensitively per owner. `ToolConnector` (`tools/mcp.ts`, `createMcpConnector`,
  `context.tools`) is the one way to call an MCP server over HTTP: `listActions` (30 s, at most
  200 actions, 64 KiB per schema) and `callAction` (5 min; text parts joined, others as
  `[image]`/`[resource <uri>]`, cut at 200,000 characters with "[truncated]", NUL and lone
  surrogates made storable), one SDK client (`@modelcontextprotocol/client` v2) per listing or
  call. Its errors are `ToolError`s with a reason made here (host, status), never the server's
  text. Redirects are followed only within the tool's origin. Everything the server sends goes
  through one screen in the connection's `fetch` before the SDK reads a byte of it
  (`tools/inbound.ts`, `screenedFetch`): at most 16 MiB per connection (every response and the
  SSE stream together), and each message (a body read whole whatever its declared type, or an
  event of a stream, told apart with the SDK's own `isJsonContentType`) refused past 100,000 JSON
  values or 200 actions (`inboundProblem`). The screen rewrites nothing; what the SDK returns has
  the tool's header values, and each word of them but a scheme name such as `Bearer`, replaced by
  "••••" field by field (`redact`: the server got them and may send them back) before anything
  reads or cuts it. A listing
  reads its pages one by one and stops past 200 actions or 64 pages; requests the server sends
  the client are dropped unanswered (Dispand offers no client capability); connecting
  included, the whole listing or call ends at its deadline or when cancelled. In production the connector's
  fetch is `guardedFetch(ownAddresses())` (`tools/network.ts`): it refuses loopback,
  unspecified and link-local addresses and the subnets of the app's own interfaces (the Compose
  network with PostgreSQL), checked on the addresses the socket connects to; development (and
  e2e) may call loopback fakes. Procedures `tools.*` (`tools/procedures.ts`): `create` saves,
  then lists the actions (a failure is stored as `actionsError`, not refused); `update` (an
  omitted header is kept, `""` removes it; a new URL or transport clears the actions, and any
  change to where or how lists them again); `refresh`; `delete` (refused while an agent, a
  skill package or a workflow's Tool step holds it: `toolHolder`); `list` and `get` give `headerNames`, never values. Headers go only to an
  `https://` URL (plain http only to loopback), and a URL can't carry credentials.
  `toolTarget` (server-only) opens the headers for a call.
  **Sign-in (`tools.auth`):** `none`, `headers` (follows from the headers) or `oauth`. An OAuth
  tool has no headers (they would reach its authorization server too) and no secret URL. The
  connector implements the SDK's `OAuthClientProvider` (`tools/oauth-provider.ts`) over the
  tool's sealed state (`oauth_sealed`, AAD `oauthAad(id)`, `tools/oauth-store.ts`: client
  information and tokens per issuer, the issuer saved last, discovery, the owner's entered
  client, and a flow under way with its `state` and PKCE verifier), each change on the row
  locked; the SDK does discovery (protected-resource metadata from the 401's challenge,
  authorization-server metadata), the client (Dispand's metadata document at
  `<app>/oauth/metadata` when the server supports them and the app's URL is https, else
  registration, else the client id and secret the owner entered), PKCE, the resource indicator,
  the issuer checks and the refresh, every request through the connector's `fetch` (the address
  guard; redirects only within the request's origin, the SDK's rule). Plain columns say what the
  page shows without opening the seal: `oauth_status` (`authorize`, `connected`,
  `reauthorize`), `oauth_client_id` (`enteredClientId` in views), and `oauth_state_hash` (SHA-256 of the flow's `state`).
  `tools.authorize` (with an optional entered client) starts a flow with fresh discovery and no
  token and returns the authorization URL; `GET /oauth/callback` (`handleToolOAuthCallback`,
  the owner's session) finds the flow by its state's hash among the owner's tools, compares the
  state, uses it up (10 minutes at most), hands the parameters to the transport's `finishAuth`,
  marks the tool `connected` and lists its actions on a fresh connection; a failure is stored
  as `actionsError`. A listing or call (`connectionTarget`) of a tool not `connected` fails
  before any request; one whose refresh is refused (its tokens discarded, or none to refresh
  with) marks the tool `reauthorize` and fails with that reason, and never starts a flow; tokens
  another connection rotated meanwhile are kept. Tokens are redacted from what the server sends
  back, with the client secrets. Only over https (or loopback), like headers. The entered
  client is bound to the issuer it is first used with (another issuer refuses the flow). The
  store (`oauthStore`) is bound to the tool's URL and transport as the flow or call found them:
  pointed elsewhere meanwhile, it reads and writes nothing, and the callback connects nothing. A
  token endpoint's refusal (any status) is reduced to its error code (`bareTokenErrors`, after
  the connection's screen) before the SDK, which logs the description, reads it; an OAuth
  connection's requests are https only but to loopback (`httpsOnly`). Refreshes of one tool run
  one after the other in the process (a refresh token is used once), each with the tokens the
  last one saved; a turn is only held by a connection still open (one that comes after the
  connection ended is given back at once, and that attempt stops). Telemetry: `tool.oauth.<step>` spans and
  `dispand.tool.oauth` (step, result). Settings → Tools
  (`_app.settings.tools.tsx`, `ToolSheet.tsx`) lists the tools, adds and edits them (header
  values are password fields, shown as "Set" once stored) and shows each action's parameters.
  Its "Sign-in" picks headers or OAuth; an OAuth tool's sheet (`ToolSignIn.tsx`) says connected,
  not connected yet or re-authorize, offers Connect or Re-authorize (`tools.authorize`, then the
  browser leaves for the server's sign-in and the callback brings it back to
  `/settings/tools?tool=<id>`, which opens the tool's sheet) and the client id and secret a
  server may give, the secret never shown again.
  The catalog (`tools/catalog.ts`) is a code constant: `github`
  (`https://api.githubcopilot.com/mcp/`) and `firecrawl` (`https://mcp.firecrawl.dev/v2/mcp`) are
  HTTP entries whose header templates (`Authorization: Bearer {token}`) are filled from the
  owner's settings; `fetch` (`uvx mcp-server-fetch`) and `brave-search`
  (`npx -y @brave/brave-search-mcp-server`, `BRAVE_API_KEY`) are runner entries. `tools.catalog`
  searches names and descriptions; `tools.installFromCatalog` creates an HTTP tool through the
  same `createTool` as `tools.create` (with `catalog_id`), or returns, for a runner entry, the
  `mcpServers` snippet for the runner's config with `"<your key>"` placeholders (no value is
  sent or stored). Settings → Tools
  has "Browse catalog" (`ToolCatalog.tsx`).
  Each HTTP entry declares its `actions` (name, description, read-only, pollable, and whether it
  asks before use by default; its `unasked` and `pollable` are derived from them by `http()`;
  an action the entry doesn't declare asks, whatever the server's `readOnlyHint`),
  and a tool made from it starts with them (`declaredActions`) until a listing succeeds and
  replaces them. `tools.addFromCatalog({ catalogId, name? })`, the grant tool
  `tools_add_from_catalog` (it creates a tool, so an item may name it with `{ "$item": n }`),
  adds an HTTP entry's tool with no header value; its zod schema refuses a runner entry with its
  snippet, so the refusal comes when proposed. `tools_catalog` is a `configure` read.
  `signInOf(row)` derives `signIn`: `needed` for an HTTP catalog entry with settings and no
  header, or an OAuth tool not connected; `connected`; or `none`. `tools.get`/`list` give it with
  `signInPath` (`/settings/tools?tool=<id>`). `connectionTarget` refuses a tool that needs
  sign-in before any request, so nothing lists or calls it, and the scheduler records such a
  poll `skipped` with "needs sign-in" at claim and again before the call (`pollProblem`, which
  also gates a trigger's creation, doesn't look at it: a poll trigger is made before the
  sign-in). The tool's sheet shows the entry's settings (`CatalogSettings.tsx`), saved by
  `tools.fillSettings` (owner only, not a tool), which seals them as the entry's headers and
  lists the actions. An agent's text links to a tool's page with its `signInPath`: `AgentText`
  navigates in the app for a path with one leading `/` and no `.` or `..` segment (`isAppPath`);
  every other link stays a button that opens a new tab.
  The mail entries (`docs/services/`): `gmail` is an OAuth HTTP entry for Google's hosted Gmail
  server, whose `oauth` (scopes and authorization parameters) goes into the tool's `ToolTarget`
  (`oauthRequest`, while `catalog_id` names it): `tools.authorize` then starts the flow with the
  SDK's `auth` at once (the server lists its actions without a token), asking for those scopes
  instead of the metadata's whole list, with `access_type=offline`; `gmail-runner`
  (`@artymclabin/gmail-mcp`) and `microsoft-365` (`@softeria/ms-365-mcp-server`, mail actions
  only) are runner entries, pinned. An entry may name `unasked` (the actions that run unasked when
  a person gives the tool to an agent, `defaultUnasked`; every other action asks, whatever the server says),
  `pollable` (written to `tools.pollable` at install) and `poll`, a poll trigger's preset that the
  trigger sheet fills in when the tool is picked. A runner tool created from the catalog's "Pick
  the runner" carries its `catalog_id` (`tools.create` takes a runner entry's id). A tool pointed
  at another URL, transport or runner tool loses its `catalog_id`.
- **Skills:** a skill package (`skill_packages`, owner-scoped) holds one or more skills, a folder
  each with its `SKILL.md` (YAML frontmatter `name`, equal to the folder, and `description`), and
  their files (`skill_files`, `bytea`, keyed by package and `<skill>/<path>`); `skills` lists each
  package's skills. `validatePackage` (`packages/domain/src/skills/package.ts`, pure) is the one
  check every way in goes through: every path passes `isSafeRelativePath`
  (`packages/runner-protocol/src/paths.ts`, shared with the runner, which will write the files
  under its session folder: relative POSIX, no empty, `.` or `..` segment, no `\`, control
  character, `.claude` or `.mcp.json` segment, 255 characters and 10 segments at most), no two
  paths collide (case ignored), and a package is at most 500 files, 2 MiB per file and 8 MiB in
  all. `skills.create`/`update` make a user-made package of one skill named like it from a name,
  description, Markdown instructions (written as `SKILL.md`) and files (base64); an update without
  `files` keeps the stored ones. A plugin's package (`plugin_id`, from plugin installs) is
  read-only: update and delete are `FORBIDDEN`; it shows "From plugin X". So is the built-in
  platform skill (`built_in`, shown "Built in"), whose name no other package may take. `requiredToolIds` must be the owner's tools;
  until MCP tools land the owner has none, so any id is `NOT_FOUND`. Settings › Skills lists the
  packages (a row expands to its skills) and edits user-made ones in a sheet.
- **Plugins:** Settings › Plugins has Discover (every marketplace's entries, searchable, and the
  Marketplaces list: add any by `https://` Git URL or GitHub `owner/repo`, sync, last error) and Installed. A marketplace
  (`marketplaces`, owner-scoped; `claude-plugins-official` and `anthropics/skills` are built in,
  seeded at setup and by migration 0017, not removable) is a Git repository with a
  `.claude-plugin/marketplace.json`; a sync (`plugins/git.ts` `fetchGit`, then
  `marketplace.ts` `parseMarketplace`) stores its entries, and a failed one keeps them and stores
  `sync_error`. An entry's source is a path in the marketplace's repository, or a Git repository
  (`github`, `url`, `git-subdir`, with its `ref`/`sha`); any other is unsupported, with its reason.
  `plugins.preview` fetches the entry and reads it (`read-plugin.ts` `readPlugin`, pure over the
  checkout, links never followed; `plugins/fs.ts` holds what both layouts share: the root, the
  read's budget, regular files and skill folders). A plugin with a root `plugin.json` is read in
  the Agent Plugins 1.0.0 layout (`standard.ts` `readStandardPlugin`, `plugins.layout =
  'standard'`). A schema-less root object beside a named `.claude-plugin/plugin.json` instead uses the Claude loader; explicit schemas retain strict validation: `plugin.json`'s `$schema` must be the 1.0.0 id (schemas
  are known by id, never fetched), its closed fields are checked (an unknown one is listed and
  ignored, as is an `extensions` that isn't an object; any other violation rejects the plugin);
  skills are the immediate folders of `skills/` holding a regular `SKILL.md`; MCP servers come
  from `mcp.json` only, checked whole (its `$schema` the same version, else no server is read)
  then entry by entry (closed `stdio`, `streamable-http` and `sse` variants, a `./` or bare
  command, a contained `cwd`, no `PLUGIN_ROOT`/`PLUGIN_DATA` in `env`, an https URL unless
  loopback, valid headers, none holding `${…}`). Of the extension namespaces, only `com.dispand`
  is read (its manifest key may hold a `description`, nothing else), and neither is a marketplace
  entry's `skills` or manifest. Its definitions (`definitions.ts` `readDefinitions`) are files
  under `com.dispand/`: `primitives/*.json` (a table: `fields.create`'s input with the referenced
  table's name for its id, the primitive flag and a parent naming one of its reference fields,
  whose table must be a primitive of the plugin), `agents/*.md` (frontmatter `name`,
  `description`, a `harness` kind hint, the plugin's `skills`, `tools` as `mcp.json` names or
  `catalog:<id>`, `bundles`, `tables` by name or `all`, `consults` of its other agents,
  `selfLearning`; the body is the system prompt) and `triggers/*.json` (`triggers.create`'s
  input with its agent's definition name, a primitive trigger's table and fields by name, a
  poll's `server` or `catalog` for its tool). Each is a regular file of at most 2 MiB (100 of
  each kind), parsed with a Zod schema built from its procedure's input, and checked against
  the plugin: a skill, server, catalog entry, agent or parent it names must exist. A table it
  names that the plugin doesn't define is left to the setup to find in the workspace. A bad
  definition, or one naming a skipped definition, is listed as not imported alone. Otherwise the Claude plugin layout is read:
  skills (`entry.skills`, else `skills/*`), MCP servers
  (`.mcp.json`, the manifest's `mcpServers`), agents (`agents/*.md`) and what is never imported
  (hooks, commands, `bin/`, servers running `${CLAUDE_PLUGIN_ROOT}`, links, files a skill can't
  hold, skills `validatePackage` refuses). `plugins.install` stores the plugin (`plugins`: url,
  sha, what it offered, its definitions (`plugins.definitions`, migration 0061), what wasn't
  imported; a plugin with definitions installs with nothing else ticked) and one skill package named after it with
  the ticked skills. That package is the plugin's: `skill_files` holds its files in effect, and
  `skill_file_upstream` (migration 0072) the files as the plugin has them, so a path whose content
  differs is its owner's change, one only in effect a file they added, one only upstream a file
  they removed. The owner changes it file by file (`skills.setFile`, `skills.removeFile`, each
  checking the whole package with `validatePackage`; `skills.readFile` for the editor),
  `plugins.update` follows the plugin only for the files the owner left alone (`rebaseFiles`),
  `plugins.resetOverride` with `file:<path>` puts one path back, and its delete is refused like
  any element's. A package kept at uninstall keeps its files in effect and no upstream ones. Ticked HTTP MCP servers become HTTP tools (only as reviewed: the server
  definitions at that commit, else `CONFLICT`; a stdio server that runs a command is refused) and
  ticked agents become a system prompt on the harness the owner picks. An imported agent or tool
  is the plugin's element (`plugin_id`, `plugin_component`): its row also keeps the plugin's
  values of the fields a plugin gives it (`upstream`) and the fields its owner changed
  (`overridden`, migration 0071). `plugins/overrides.ts` owns both: `ELEMENT_FIELDS` classes
  every column of `agents` and `tools` as the plugin's, a local setting (harness, model, headers,
  sign-in, enabled actions) or the system's, and a test fails on an unclassed column;
  `agents.update` and `tools.update` call `overriddenAfter`, so a field that now differs from
  the plugin's value is an override and one written back to it is not; `plugins.update` goes
  through `rebase`, which replaces what the owner left alone and stores the new value under an
  override; `plugins.resetOverride` writes the plugin's value back through the element's own
  update. A plugin's agent or tool isn't deleted on its own (`refuseOwnDelete`), is named inside
  its plugin (`tools_workspace_name_idx` is unique per workspace and plugin; shown as `<plugin>/<name>`,
  `plugins/names.ts`), and what an uninstall keeps becomes its owner's own, with no `upstream`.
  A definition makes nothing
  on install: what is set up from one is the owner's, listed in `plugins.created` (by kind, and
  under `from` by definition key, `primitive:<name>`, `agent:<name>`, `trigger:<name>`), and
  `plugins.list` names it for every plugin and marks each definition whose row still exists.
  `plugins/setup.ts` sets tables up from definitions: `setupItems` turns those picked into
  proposal items (every `tables_create`, then every `fields_create`, then each
  `tables_set_primitive`, with `{ "$item": n }` where an id goes, each parsed by its procedure's
  input through `parseWithRefs`, as a proposal's are). What `created.from` records is reused by
  id while its row exists; a name of one of the plugin's tables never binds by name, and any
  other table name finds the workspace's table or waits (`waiting`). `plugins.setupPreview` shows
  the items through `itemsView` (`proposalView`'s naming) and `plugins.setUp` makes them as the
  owner (`runItemsAsOwner`: each through its procedure with the owner's own context, stopping at
  the first refusal, every id recorded with `recordCreated`, which `recordInPlugin` uses too; span
  `plugins.setup`, metric `dispand.plugins.setups`). Both are owner-only and not tools.
  `plugins.install` takes the same pick as `setup`, in one confirm: the install sheet shows each
  ticked agent definition's rights in words from the definition itself (no plugin row exists yet
  for `itemsView`), and `plugins.preview`'s `reviewed` covers the definitions as well as the MCP
  servers. The pick is turned into items inside the install's transaction, so one it can't make
  (a table naming another plugin table left unticked) installs nothing; the items are made after
  the commit, and one refused leaves the plugin installed, with Set up going on from there.
  Since no items are shown, a setup run from the install (`setupItems(…, fromInstall)`) gives
  every tool on Ask and adds no plugin server the install left unticked (it waits for Set up,
  which shows its address), and a poll of an agent it makes waits (a poll runs its action
  unasked); the sheet lists what was refused or left waiting.
  The Assistant proposes the same install: `plugins_discover`, `plugins_preview` and
  `plugins_list` are `configure` reads, and `plugins_install` is a grant (a proposal item) whose
  input carries `plugins_preview`'s `reviewed` and the `setup` pick. Every install requires
  the token, whatever it picks; from a Job, it also refuses MCP servers, settings, agent files
  and a native install; its setup items run under the Job's context, whose approved item is the approval.
  A tool's `shown` hook runs when an item is proposed: for `plugins_install` it reads the plugin
  again, refuses a token that isn't that read's, and stores the picked agents' rights on the item
  (`ProposalItem.shown`), which `proposalView` returns and `PluginInstallItem` shows. The tool's
  `tables` is the whole workspace, so only a Job on every table proposes it.
  `marketplaces_add` (`marketplaces.add`, a Git marketplace or skill repository, or with
  `kind: "well-known"` a skill site) is a grant too: its `shown` hook resolves the address as the
  add will (`marketplaceUrl`, `wellKnownIndexUrl`) without fetching it, so the Inbox shows the
  address that will be read and an address the add would refuse (not https, credentials) is refused when proposed; its Audit rows
  are about a `marketplace`. Listing, syncing and removing marketplaces stay the owner's.
  What a setup makes is the plugin's from its insert: `runItemsAsOwner` passes
  `context.pluginElement` (a value no input sets) and `tables.create`, `fields.create` and
  `agents.create` write it on the row (`tables.plugin_id`, `plugin_component` and the
  `definition` it was made from; `fields.plugin_field`; an agent's `plugin_id`,
  `plugin_component` and `upstream`; migration 0073). A plugin's table is named inside its
  plugin (`tables_owner_name_idx` is unique per owner and plugin), isn't deleted on its own, and
  a name in a definition that isn't one of the plugin's tables finds only the owner's own.
  Triggers come last, one `triggers_create` each on its agent (made before, or by an item of
  the same setup): a table-change trigger names its table and fields by id, a poll its tool (the
  plugin's server's, or the owner's catalog tool, added by an item when missing). A trigger whose
  agent isn't set up, whose field isn't there yet, or whose poll `pollProblem` would refuse is
  listed in `waiting` instead of stopping the run; a poll on a server this same setup adds waits
  until that tool has listed its actions. A plugin's trigger keeps `plugin_id`,
  `plugin_component`, `upstream` and `overridden` (migration 0074): `triggers.update` records
  overrides of its name, instructions, config, concurrency and rate (on or off is a local
  setting), `triggers.delete` refuses it, and `plugins.resetOverride` takes `kind: "trigger"`.
  Agents come after the tables, one `agents_create` each, on the harness picked: the plugin's
  agent (prompt, description, bundles, self-learning), whose fields the owner overrides as any
  plugin agent's. Its tables resolve as above, else wait; its skills give it
  the plugin's skill package when one is installed in it; its tools are those already added for
  the servers and catalog entries it names, else added by an item placed before the agents: a
  `tools_add_from_catalog` for an HTTP catalog entry, a `plugins_add_server` for one of the
  plugin's HTTP servers (also for the servers picked alone). `plugins.addServer` (`plugins/servers.ts`)
  adds that server through `createTool` with no credentials, only at the URL and transport the
  owner reviewed (the stored components', else `CONFLICT`), records it in `created` under
  `server:<name>`, and refuses a stdio server or one whose URL needs a setting (the install sheet
  adds those). Such a tool reads "needs sign-in" while its listing is refused with a 401 or 403
  (`signInOf`), until the owner enters its headers or signs in on its page; its consults name the agents this setup makes before
  it (`$item`, ordered so a consulted agent comes first) or those the plugin made earlier. A
  missing skill, tool or consult is listed in `waiting` and the agent is made without it.
  `plugins.updatePreview` syncs the marketplace, reads the entry's current commit and returns
  what an update would change (`plugins/update.ts`): for each of the plugin's agents, tools and
  triggers, `planElement` compares the plugin's new values with the ones kept underneath
  (`upstream`), a definition's names resolved to ids as a setup resolves them. A field the owner
  overrode that the plugin changed is a conflict; a field they left alone follows, classed by
  `classify` as `widening` (an agent gains a bundle, a table, a skill, a tool or a consult, or a
  consult stops asking; a tool's URL or transport; a trigger's config, more Jobs at once or an
  hour), `wording` (an agent's name, description or instructions, a tool's name, a trigger's
  instructions, a skill taken off an agent, a skill's files) or `silent`. `FIELD_CLASS` holds
  every overridable field to a class, by a test. `plugins.update` applies at once when nothing
  is a conflict, widening or wording; otherwise only with the preview's `reviewed` token, and
  with `take` naming the conflicts whose plugin value the owner takes. It stores the plugin's new
  values underneath, then writes each element through its own procedure (`tools.update`,
  `agents.update`, `triggers.update`), so their checks apply and a tool moved to another origin
  loses its headers; an element its procedure refuses is returned in `failed`.
  What the new version defines that the installed one didn't (`additionsOf`: definitions and
  HTTP servers) is returned as `additions` and is part of the token, but the update makes none
  of it: once it is applied, the row opens the plugin's Set up, whose items show what each new
  element would be allowed to do and whose own `reviewed` token binds what is made. A definition of a staying agent or
  trigger that names a catalog tool the owner lacks, or an element that version adds, is linked by no update until it
  exists: `elementPlans` returns each as a `later` sentence, shown as `later` (informational, not in the token); Set up's
  `waiting` says the same when it makes an agent without a tool or consult. What the new version no longer has
  (`leavingOf`: an agent, a table or a tool with no definition or component of its name; a
  trigger with no definition, or one that names another agent now) is returned as `removals`:
  `inUse` with that `leaving` set, so the plugin's elements the update keeps count as staying,
  each staying agent read as the update leaves it (`afterOf`). A dropped trigger whose agent
  stays is an element of its own (an override, an unfinished Job it started, changes held back,
  a widget). `plugins.update` takes a `choices` record as an uninstall does, re-checks the
  removals with the plugin's tables locked, and applies them through `removeElements`, the
  function the uninstall uses. `releaseNotes` gives the installed and the new commit and, when
  the plugin has a `CHANGELOG.md` at its root (a regular file of at most 256 KiB, read with the
  checkout, `plugins/release-notes.ts`) whose heading names the new manifest version, that
  section, cut to 10,000 characters. The checkout is shallow, so no commit subjects between the
  two are shown. The sheet renders it as plain text.
  A plugin's table isn't overridden: `tablePlans` compares the definition it was last merged
  with (`tables.definition`) to the new one (`plugins/table-merge.ts`, `tableChanges`) and lists
  each difference with its starting tick: a field added or a move ticked; a removal, a type
  change, choices removed or replaced, the primitive flag or the parent unticked, with the rows
  whose values it takes away; one the owner already changed is `stale`, and one naming a table
  that isn't there yet `waiting`. `plugins.update` takes the ticked keys per table (`tables`),
  part of the `reviewed` token, applies each through the field or table operation a person uses
  (`applyTable`), then keeps the new definition of every table the version still defines, but
  for what waits, which the next update offers again. A declined change isn't offered again by
  an update: it shows on the plugin's row (`plugins.tableChanges`, the same `tablePlan` from the
  table as it is now to the definition kept), each with "Apply" (`plugins.applyTableChange`,
  through `applyTable`, leaving the definition kept as it is). We decided its token covers the
  table now (its fields, flags and, for a change that takes values away, those values), the
  plugin's installed commit, the definition kept and the change: one read before a table edit,
  or before an update that changes that table's definition, is refused. As in the update, the
  token is checked and the change then made through the field operation, under that operation's
  own lock: a value written in between to a field being removed goes with it, which we accept
  (removing the field is what was asked). A move that would have to move the table's first field
  is `stale`: the update's reorder keeps the first field first. Set up also offers the plugin's HTTP servers
  that aren't tools yet and need no setting, unticked (`pick.servers`). A tool an update gives
  an existing agent is attached with every action on Ask (`toolPermissions` with nothing
  unasked): the update's screen shows the tool gained, not which actions would run unasked.
  `plugins.uninstallPreview` returns each of the plugin's elements (agents, skill packages,
  tools, tables) with why an uninstall asks about it and the other elements it needs
  (`plugins/closure.ts`, `inUse`): its owner changed it (an override, a trigger's override, a
  skill file, a table's fields), it holds rows, memory or a running Job, or something that stays
  refers to it. `REFERENCES` classes every foreign key to an element's table as part of the
  element, its history, content, or a reference followed, and a test holds the schema to it.
  `plugins.uninstall` and an update that drops elements first lock every element row of the plugin (`lockElements`: the consult lock, then tables, triggers, agents, skill packages, tools, in the order their writes and a Job's start take them), so an override or a new use waits for the removal. `plugins.uninstall` takes the preview's `reviewed` token and a choice per element (`keep` or
  `delete`), checks them as a whole (`checkChoices`: every element asked about has a choice,
  one a workflow uses, or a table whose rows a table that stays names, is kept; what a kept
  element needs has a stated choice; a kept table's referenced tables are kept with it) and applies them
  in the order agents, skills, tools, tables: a kept element becomes its owner's own (a tool or
  a table under a free name), any other goes, and what used it loses it. The removal sheet
  (`PluginRemoval.tsx`, `removalPlan`) starts everything asked about kept, lists what a kept
  element needs under it, and selects matching native bindings. Native removals use reviewed revisions, one harness at
  a time, before the atomic workspace removal; a failed native operation leaves the workspace
  plugin present and shows partial native progress without repeating completed removals.
  `plugins.uninstall` accepts an explicit checklist scoped to that plugin's owned rows. Checked
  skills and tools are unlinked from kept agents and skill requirements, then deleted; a current
  or active workflow's tool still blocks deletion. Selected agents use `Engine.deleteAgents`,
  preserving Job history. Unticked components become the owner's own (`plugin_id` set null),
  including unused skill packages; setup-created business data stays. Calls without a checklist
  retain the previous behavior: keep agents and tools, and delete only unused skill packages.
  Reinstalls name copies apart (`agentName`, `toolName`, `skillPackageName`). Reinstalling imports a separate skill package
  under the first free numbered name (`-2`, `-3`, …), preserving retained files and agent links.
  The install sheet defaults to complete native installation on every eligible runner/harness
  pair; explicit exclusions persist while the sheet is open. `db/cascades.test.ts` walks every cascading
  foreign key from `plugins` and fails on one reaching the owner's data. A marketplace with
  installed plugins can't be removed.
- **Skill sources:** a marketplace row has a `kind`. `marketplace` is the format above. A Git
  repository with no `.claude-plugin/marketplace.json` but a `skills/` folder is a `skill-repo`: one
  entry, named after the repository, read by `readPlugin` like a plugin. A `well-known` site
  (`plugins/well-known.ts`) publishes `https://<site>/.well-known/skills/index.json`
  (`{ skills: [{ name, description, files }] }`, files at `/.well-known/skills/<name>/<file>`):
  one entry, named after the host. Install downloads each listed skill over https and checks it
  as a package of its own, and its `sha` is a SHA-256 of the files. Redirects are followed only
  to the same origin (at most 3). Caps: an index of 1 MiB and 200 skills, 2 MiB per file, 32 MiB
  and 60 s per read. Add picks the kind ("Git repository", auto-detected as marketplace or skill
  repository, or "Skill site").
- **Add from a link:** `/settings/plugins?add=<source>&kind=git|well-known` (`git` by default)
  fills Discover's add form, `owner/repo` shown as the GitHub URL the server reads, and nothing
  more: the person adds it with the form's button, through the same `marketplaces.add` as a
  typed source. The source is text only, never followed or fetched before then; one longer than
  the field's 2000 characters, or an unknown kind, is dropped. Above the form, someone in
  several workspaces picks the one it goes to (`?w`, kept with the source), and a member reads
  that only a manager can add it. Signed out, the link comes back after sign-in (`?redirect`).
