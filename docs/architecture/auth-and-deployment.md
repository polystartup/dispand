# Authentication, gates, the server and deployment

- **Authentication and authorization:** Better Auth (email + password) at `/api/auth`, one
  owner. Sign-up is disabled: the first-run screen calls `auth.setup`, which creates the owner
  only while no user exists. Route guards (`getAuthState` server function) send fresh installs
  to `/setup` and signed-out visitors to `/login`.
- **Organization gate** (`workspace/gate.ts`): an install may refuse an organization for a
  while. The hook is `Tenancy.refusal(organizationId)`, given with the tenancy to
  `openDb(client, { tenancy })` and read with `refusalOf(db, organizationId)`. It is
  synchronous: it answers from what the install keeps in memory, is ready before `startApp` and
  never throws. It returns `{ key, link }` or undefined. `key` is a message key the install
  registered (`registerMessages`), else the refusal says `organization.refused`; `link` is an
  absolute `https:` URL or a same-origin path. With no hook (the default) nothing is refused and
  nothing is looked up for it. A refusal answers FORBIDDEN with
  `data: { key, link, organizationId }`, counted by `dispand.organization.refusals` (by where it
  was met) with an `organization.refused` span event. It is checked at use, only once the caller
  is admitted there, so a non-member still gets NOT_FOUND and learns nothing:
  - requests: `member` (people and Jobs, so `manager` too), `orgOwner`, `inPlacedScope`
    (`jobs.get`, `jobs.def`, `runs.get`, `runs.access`, `artifacts.get`), `asManager` (the
    workspace's people and invitations), `asMember` (`GET /files/<id>` and the OAuth callback,
    which answer 403 with the sentence) and all four invitation procedures (joining is a write
    into the organization);
  - a Job's calls into Dispand, as tool errors: platform tools (`callPlatformTool`, before an
    approved proposal item is taken, so a refusal never uses one up), installed tools of runner
    sessions (`/mcp/job/tools`) and of cloud sessions, and its runner tools' files
    (`/mcp/job/files`, 403). Never as a refused token: a 401 sends an MCP client looking for a
    sign-in.
  - Open, as they reach into no organization: `auth.*`, `workspace.mine`, `workspace.managed`,
    `profile.get`, `profile.update` (its Audit rows skip refused organizations),
    `push.unsubscribe`, Better Auth's routes and health. `workspace/gate.test.ts` calls every
    procedure into a refused organization and fails on one that answers but these.
  - Open by design: the runner's pairing, update, downloads (plugins, packages, attachments) and
    connection. A turn already running is not cut and keeps what it fetches; what would start
    or resume is held instead (background work, below).
  - Background work (`engine/`), held, never failed:
    - Slots (`engine/slots.ts`): `take` gives no free place to a step of a refused
      organization's harness, which queues instead (its class, from now); `hand` hands nothing
      on such a harness: its queue stays in order and its places stay free. A harness is one
      workspace's, so no other organization waits behind it.
    - `rootGoing` and `rootGoingLocked` answer false for a run of a refused organization, read
      through the run's workspace (a workflow run has no root): every path that would start,
      resume or deliver to a session holds the step as for a paused root (`hold`: its slot given
      back, its `pending_action` kept), a reconcile holds what it would deliver to a live
      session, and every answer or chat message is checked at its one send (`sendClaimed`, held
      once). The scope check that fails a Job (`lostScope`) doesn't ask the gate.
    - A workflow's Tool and Data steps, which run in the engine with no slot, are held the same
      way (`pending_action` start), and a consult a Job asks stays pending, its consulted Job
      not made, as for a paused root (`openConsult`).
    - The refusal is a required argument of `take`, `give`, `next`, `release`, `rootGoing` and
      `rootGoingLocked`, asked inside their transactions (the hook is synchronous); null when
      the install refuses none, and then nothing is looked up. Each refusal counts in
      `dispand.organization.refusals` (`work`). Settling an idle chat isn't held: it ends work.
    - Every scheduler tick, only when the install may refuse an organization, `Engine.redrain`
      hands the free places of harnesses with queued steps (`slots.next`), then wakes the held
      steps and hands over those that kept their slot to deliver or resume (`heldWork`: root
      going or none, not a person's pause, not a replaced session waiting for its former one),
      and opens the waiting consults, of the organizations allowed now, per workspace
      (`redrainScopes`). It runs before the tick's claims, and its failure is logged without
      holding them up. Work held while refused goes on within a tick of the install allowing it
      again, without a restart. Boot `recover` isn't filtered: its repairs run for every
      organization, and the checks above hold what they would start.
    - Checked where work is admitted: work admitted before the refusal comes goes on, as a turn
      already running does (a start being prepared, its memory or grant, is sent; a step being
      claimed runs). Not held, by design: runner events (they report work done), push
      notifications, the escalation sweep, idle-chat settling, the attachment and Audit sweeps.
      A cloud session found running at boot is reconciled as lost and held to resume. A delivery
      held during a turn that then ends while refused goes at the session's next reconcile.
      Once allowed, until the next tick, a new start may take a free place ahead of a step
      queued while refused.
    - Scheduled work: the scheduler claims nothing of a refused organization, and loses nothing
      of it. Before a tick's claims, and only with a hook (`refuses`), `claimOrganizations` lists
      under SYSTEM the organizations with work due (from the listings `eachScope` uses), the hook
      is asked once for each, and each refused one counts once (`work`). The claims (schedules,
      schedule triggers, polls, events, deferred event fires and poll items) then take only rows
      of the organizations it allowed, through a predicate on the row's workspace
      (`scheduleWithin`, `triggerWithin`, `eventWithin`, `eventFireWithin`, `pollItemWithin` in
      `engine/discovery.ts`): work that fell due after the listing, in an organization it didn't
      name, waits for the next tick. So the hook never runs under the claims' row locks, and a
      refused organization's rows never take the batch from another's. They stay due, with no
      fire, Audit row or `refused` status, and once the organization is allowed again they are
      claimed as after downtime: a schedule and a schedule trigger fire once, for the latest time
      missed (`latestFireBetween` from `last_checked_at`); a poll runs once on the next tick, its
      `{{lastPoll}}` still its newest item's, so no item is skipped; events are matched in order,
      and deferred event fires and poll items start as their trigger's room allows. A poll
      already claimed (its walk, and those queued behind it on the same runner tool) goes on to
      its page cap. The nightly purge (`purgeArchivedPeople`) keeps a person whose archiving
      organization is refused: its owner can't restore them meanwhile, and the purge can't be
      undone.
  - streams (`questions.stream`, `rows.stream`, `runs.stream`): `inStreamScope` asks after
    `admit`, on open and before every event. While a stream waits with no event, `untilRefused`
    (`rpc/context.ts`) asks the hook alone (no read, nothing yielded) every
    `ORGANIZATION_RECHECK_MS` (30 s) and throws the refusal: the client gets a FORBIDDEN error
    event, not `done`, and the stream drops its subscription. Before sending it, the stream runs
    `admit` again, so someone removed while the stream was idle gets `admit`'s answer instead
    (the re-check reads nothing while allowed, so an idle stream ends for a removed person at
    its next event or refusal, not at the removal).
    With no hook, no timer runs. As on requests, the refusal comes after workspace admission and
    before per-row visibility: a member asking for a run of their workspace they can't read gets
    the refusal, not NOT_FOUND.
  - The page:
    - **Detector:** the page's link (`lib/api.ts`, `translateErrors`) notes every FORBIDDEN error
      carrying `data.link` and `data.organizationId` in a small store (`lib/organization-refusal.ts`),
      keyed by the organization the error names, never the tab's: a call sent before a switch can
      fail after it. It sees a call's failure and a stream's later error events, the returned
      iterator being wrapped (`mapEventIterator`), so those are translated too. Every other FORBIDDEN
      (a manager-only action, a limit) stays the caller's to show inline. The store lives in its own
      module, written only from the link, and is read with `useSyncExternalStore` (none on the
      server, so hydration matches).
    - **Full page:** while the tab's organization is refused, the `_app` layout renders a page in
      the shape of the sign-in card instead of the shell (`Shell`): the server's sentence (else
      `organization.refused`), the link as a plain `<a>` only when it is an https address or a path
      of this origin, "Try again", the workspace switcher slot and the account menu. The shell
      unmounts with its streams, polls and queries, so nothing keeps calling into the organization.
    - **Asking again:** "Try again" forgets the refusal once and the shell's calls ask anew; a switch
      to another workspace, and a reload, forget it too. Nothing re-asks on its own.
    - **Home's guard:** `firstLaunch` (`server/auth-state.ts`) asks in the tab's workspace (`?w`,
      else the only one; a server function's request carries no workspace headers) and reads a
      refused organization as no first launch, so Home renders and its calls bring the full page,
      instead of the router's error.
- **Place gate** (`engine/places.ts`): a process that embeds Dispand beside others on one
  database passes a `PlaceGate` to `buildApp` (`gate`), and the engine asks it before working on a
  step's place (the runner connection its session is on, its cloud session, its Tool step's call):
  a start or a resume (`launch`, `resume`), a slot's hand-over or wake, an answer or a chat
  message (`flush`, `answer`, `message`), each step of a runner's `reconcile`, a Tool step's call
  (`tool`, before its claim) and recovery's failing of a Tool step left running (`failTool`). A
  refusal writes nothing, not even a hold: what the work would have sent stays owed in its rows,
  for the place's holder to send. Refusals are counted by `dispand.engine.gate_refusals` (by
  work). Without a gate (the default) nothing is asked and no path awaits anything more.
  `engine/place-sites.test.ts` lists every call to the adapter, the cloud runner and Tool steps,
  and every write of a session's delivery state, and fails on one that isn't classified as gated,
  holder-only, forwarded through the adapter, local, or a row write.
  The cloud runner asks the same gate (`drives`) at each entry (`start`, `send`, `steer`,
  `answer`, `interrupt`, `stop`, `resumeQueued`) and for each session its `recover` finds. A
  refused start, message or answer writes nothing and answers false, so the engine keeps it owed;
  a refused interrupt, steer or stop goes to `carry`, which runs it where the session is driven
  and returns that answer. Recovery returns a session this process drives already (its loop or a
  state change under way) as live, with no replay, and leaves one the gate refuses alone.
  Refusals are counted by `dispand.cloud.gate_refusals`; `cloud/cloud-gates.test.ts` fails on an
  entry that isn't classified or acts before asking. A carried stop that fails (the driving
  process died, or its answer never came) changes nothing the rows record: the step is stopped,
  so no new turn starts (`claimCloudTurn` reads it), and the driver ends the session and cuts its
  calls when it next delivers for the step. Until then the turn under way may go on: this window
  is accepted, as a stop that never reached a runner is today.
  The place's holder learns of such owed work from outside the engine, and runs
  `Engine.deliver(stepId)` for the step: from its rows, it does what `reconcile` does for a live
  session (ends the session of a step no longer active and cuts its Tool call, hands over or wakes
  what a slot was handed or held for, sends a start never written, narrows permissions and sends
  undelivered answers and chat messages), under the engine's own claims, so each row goes once
  however often it runs. Public Dispand never calls it.
  A runner's connection is a place too: `buildApp` takes a `runnerAdmission`, which the hub asks
  after a connection's token and protocol checks, right before the upgrade (with the runner's id
  and its token's stored hash); a refusal answers 503 (`dispand.runner.connections`,
  `not-admitted`), and the runner retries within a second, each time. Once admitted, the hub
  reads the runner's `last_seq` again: the process that held it before may have handled more.
  `RunnerHub.handOff` ends the runner's connection (close 4002, after which the runner dials
  again within a second) without refusing the runner (as a new connection
  replacing it does, unlike `disconnect`, which refuses it until the process stops), resolves
  once the message it was handling is handled, and makes its next connection start from the
  database's `last_seq`. Public Dispand never hands off.
  The runners' update states (`RunnerHub.updates`, `UpdateStates`) are this process's own by
  default (`RunnerUpdates`, synchronous); their three callers (the runner's update poll, the
  runner list and the update request) await each answer, so such a process may keep them where
  every process reads them.
  Attachment files' bytes go through a file store (`data/file-store.ts`), by default local disk
  at `DISPAND_FILES_DIR`; processes on several hosts give `buildApp` a `files` they all reach.
- **Web server settings** (read only in `apps/web/src/server/config.ts`; the mode comes from the build,
  never from NODE_ENV; `createAuth` sets every option Better Auth would default from NODE_ENV): `DATABASE_URL` (required), `BETTER_AUTH_SECRET`,
  `BETTER_AUTH_URL` (public URL of the app), `DISPAND_SETUP_CODE` (first-run code, 16+ characters), `DISPAND_SECRET_KEY` (32 bytes in base64, the secret box's key; changing it loses every stored secret) and `DISPAND_FILES_DIR` (attachments): required in a production build, fixed dev defaults
  otherwise. All are read from the environment; `deploy/compose.yaml` fills them from the
  `DISPAND_*` variables listed in `deploy/README.md`. `/api/rpc` demands the oRPC CSRF header (`x-csrf-token: orpc`, added by the client
  link), which cross-origin forms cannot send.
- **Class names:** the design tokens are Tailwind classes through `tokens.css`'s `@theme`
  (`src/styles.css` is Tailwind's entry). A class name Tailwind doesn't know, in a `className`,
  a `cn()` or `cva()` call or a variable named `className`, fails lint
  (`better-tailwindcss/no-unknown-classes`); one kept in another constant isn't checked.
  `eslint.config.js` lists the few it allows (plain CSS of `styles.css`, and the names React
  Flow and the dashboard's drag handle look for).
- **Build and migrations:** the web build leaves `@dispand/domain` external (its message
  catalogs apart), so an entry that imports both gets one domain module, and the domain finds
  its own migrations and skill files. It runs from the domain's packed form (compiled `dist`):
  the image unpacks the `pnpm pack` tarballs of the domain and the runner protocol over their
  deployed copies. PGlite stays external too (it loads wasm and data files next to its own code).
- **Package:** `@dispand/web` packs (`pnpm pack`, after `pnpm build`) the server bundle, the
  client files and `server.ts`; its root is `dist/server/server.js`, with its declarations
  (`dist/types`, emitted by `tsc` on pack). With the packed domain and runner protocol it
  installs outside the repository, and an entry there compiles under `strict` with no shim
  (`apps/web/package-check/check.sh` checks it on PostgreSQL). The packages stay `private`: nothing publishes them.
- **Design:** tokens in `apps/web/src/styles/tokens.css` (Hanken Grotesk over the system fonts,
  neutral palette, one `--accent`); light/dark follow the system, the user menu stores an
  override in `localStorage`, applied as `data-theme` on the root before first paint; Tailwind's
  `dark:` follows the same choice (`@custom-variant dark` in `apps/web/src/styles.css`).
- **Production entry:** `node server.ts` in the deployed tree (the image; `PORT`, default 3000,
  and `HOST`, read by `loadServerConfig` like the other settings) calls `serve` from the custom
  server entry `src/server.ts`: a srvx Node server for `dist/client` and the Start handler, with
  request bodies capped at 1 MiB, 11 MiB for `/api/rpc/files/upload`, `/api/rpc/skills/create`
  and `/api/rpc/skills/update` (413 when announced larger, 411 without a length), the runner
  hub's upgrade, and on SIGINT/SIGTERM the runners' sockets, the server, then the app closed.
  Without an app given, it starts its own right after listening (`startOwnApp`), not at the first
  request: the migrations, recovery and the scheduler run at boot, and a start that fails (the
  database not up yet) is tried again every 5 s, and by any request meanwhile. When another process
  holds the database (`DatabaseLocked`: at boot, or once this one's lock is lost with its
  connection, as another may take it then), it logs `another Dispand process runs on this database: this
  one stops` and exits at once with code 1, whether its app runs, starts or waits to start again,
  for its supervisor to start it again: a graceful stop would wait for work its engine goes on
  with meanwhile.
  The hub and the routes share one `getApp()`. In dev, `vite-plugin-hub.ts` hands `/runner/ws` upgrades on
  Vite's server to the same hub.
- **App startup** (`src/server/app.ts`): `buildApp(db, config)` constructs the app around an
  open, migrated database (auth, the hub, the engine, the scheduler, the push sender, one of each
  per app) without starting anything; `startApp(app)` then syncs the platform skills, ensures the
  Assistants, reseals tool headers, settles overdue idle chats, recovers the engine, starts the scheduler, the hourly sweep
  and the push sender, in that order. `getApp()` first holds `DATABASE_URL`'s database for the
  process (`lockDatabase`, `db/client.ts`): a session advisory lock (key 28263442198654564,
  "dispand" in ASCII, past the 32-bit `hashtext` keys the transaction locks take) on a connection
  of its own, outside the pool, with `idle_session_timeout` off and TCP keepalive at both ends
  (PostgreSQL gives up on a silent process within 15 s, the process on a silent server within
  about 20 s: a lost host or a failover ends it like a restart, and the lock is free by the time
  the process's successor starts), so one process per database runs the engine and a second gets
  `DatabaseLocked` before migrating anything; nothing is taken on PGlite. It then opens and
  migrates the database, builds and starts once per process; a failed start keeps the lock and is
  retried on the same built app, so its engine stays the one driving the cloud sessions its
  recovery took up, and `closeApp` releases the lock once the database is closed. A lock lost
  with its connection (a PostgreSQL restart, `pg_terminate_backend`, a silent server) isn't taken
  again: another process may hold it at once while this one's engine still writes through its
  pool, so the lock's `refused` settles (Production entry: the process ends) and from then on a start fails with `DatabaseLocked` (the lock's `refusal`)
  before it migrates, and again before `startApp`. `buildApp` and `startApp` take no lock: an entry that runs several
  processes on one database guards them with its `gate` and `runnerAdmission` instead. Another entry with its own
  database and startup starts telemetry (`startTelemetry`) before opening its database, builds
  its app and hands it to `serve` (or `setApp`) before taking requests (`src/server.ts` exports
  them, with `loadServerConfig` and `closeApp`);
  the routes and the hub then use it. Only the app (started, and built) and its lock stay on
  `globalThis`, so dev reloads reuse them.
- **Health** (`GET /api/health`, `src/server/health.ts`): 200 once the app started and the
  database answers and, in a process whose scheduler runs, while a tick completed in the last 5
  minutes (`Scheduler.sinceTick`: a failed tick doesn't count, the poll walks a tick began don't
  hold it, and the scheduler's start counts as one, so the first tick has as long); 503
  otherwise. The body is `ok`, `ok: last scheduler tick <n> s ago`, `stale: last scheduler tick
  <n> s ago` or `unavailable`, never an error's words, and the check makes no span or log;
  Compose's healthcheck and the image's smoke checks read only the status.
- **Upgrades:** every entry hands the raw request, synchronously, to `upgradeRunner`
  (`@dispand/domain/upgrade`), the one guarded way in: it puts an error listener on the
  socket before anything waits, and `RunnerHub.handleUpgrade` parses the target safely (400 if
  it doesn't parse, 404 if it isn't `/runner/ws`) and gives every WebSocket an error listener.
  Entries don't parse URLs or touch the socket (`upgrade-entries.test.ts` scans them).
- **Deployment:** the Docker image is published to GHCR (`ghcr.io/polystartup/dispand`), and
  `deploy/compose.yaml` is the reference Compose project (the app and PostgreSQL, named volumes;
  `deploy/README.md`). HTTPS is done by the operator's reverse proxy, which forwards to the app's
  published port 3000, must set `X-Real-IP` and must support WebSockets on `/runner/ws`; nothing
  else may reach that port.
- **Decisions:**
  - Skills from other catalogs come only through Git repositories and `.well-known` skill sites
    Mastra has no skills catalog or API of its own: its loader lives inside
    the framework, and its Agent Builder browses skills.sh. The skills.sh API needs a Vercel OIDC
    token, so an app deployed off Vercel can't call it. Most skills.sh entries are GitHub
    repositories, which can be added directly.
  - TypeScript 6, not 7: typescript-eslint does not support 7 yet (revisit with its 7.1 support).
  - Better Auth reads only `x-real-ip` for the client IP (rate limiting): the reverse proxy in
    front of the app sets it to the peer it saw, and only that proxy may reach the app's port.
  - `routeTree.gen.ts` is committed so `typecheck` works before `build`.

