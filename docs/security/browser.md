# The browser and the network, to the app

- **Every API procedure checks authorization**, and only the procedures meant to be public are
  exposed through OpenAPI.
- **A page loads from, and connects to, the app's own origin only.** Every HTML page is
  served with a Content-Security-Policy that keeps scripts and stylesheets (plus inline ones),
  images (plus inline `data:` and `blob:`), media and fonts to the app's origin, connections
  to it too, and allows no frame, object, foreign `base` or form target, nor being framed
  (`server/page-security.ts`). Text an agent wrote is shown in many places; whatever a
  renderer makes of it, the browser can't be made to fetch from, or send to, another host. A
  served file keeps its own stricter policy (`default-src 'none'; sandbox`). The one
  exception is a generated artifact the owner chose to run (below).
- **An agent's text is shown formatted, and loads nothing.** In the chat and in a Job's
  transcript on its run page, an agent's words go through one component (`components/chat/AgentText.tsx`): an image shows only when its
  address is one of the app's own files (`/files/<id>`, nothing else: no scheme, no host, no
  `..`), and is otherwise replaced by its description; a link is never an anchor but a
  button that shows its destination and opens it in a new window on a click, and only for
  `http(s)` and `mailto`; raw HTML in the text is not rendered. The owner's own words stay
  plain text. The page policy above stands behind it.
- **A generated artifact's code requires access to its Job, and only `artifact_show` makes one.**
  The code lives in `artifacts` and leaves the server only through `artifacts.get`, which checks
  the parent Job's current workspace access and matches its owner to the artifact owner.
  Messages, snapshots, events, Audit rows and telemetry carry a reference (ids, title
  for the card, format, size) or less. A tool message gets an artifact reference only from
  `artifact_show` run by `callPlatformTool`: an MCP or native tool's result shaped like one is
  never stored as one. No route serves artifact code as a page.
- **An artifact runs only when its viewer clicks Run, alone in an opaque frame.** Before Run,
  the chat shows a card (title, format, size) and, on "Show code", the code as plain text:
  nothing of it is rendered as HTML, so no frame, script or request exists
  (`components/chat/ArtifactPart.tsx`). Run first says, in the app's own words, that the code
  may then send anything it holds outside Dispand; the click is not remembered. The code then
  runs in a `sandbox="allow-scripts"` `srcdoc` frame (Generative Frame, `opaqueOrigin`, pinned
  to an exact version): an opaque origin, with no cookies, storage or access to the page. It
  enforces Generative Frame's policy (no CDN, no connection, no nested frame, no `eval`) and
  inherits the page policy above, which still blocks other hosts' scripts, stylesheets,
  images, connections and navigation if the frame's own policy fails. WebRTC is the channel
  no browser's CSP covers: a running artifact could use it to reach a STUN or TURN server.
  That is why it runs only on a click. Its bridge to the chat gives it no tool; a prompt it
  sends only goes into the draft, which the owner still sends; a link opens only if it is
  `https:`, after the owner confirms its address, with `noopener`. Messages count only from
  the frame's own window. Expand exists only on a running artifact and mounts the same frame
  with the same options in a dialog under the app's own line saying the agent generated it and not to enter secrets
  in it; the frame is given the app's theme (colors and font), no data.
- **The frame's isolation holds in Chromium, Firefox and WebKit.** The end-to-end checks of the two
  items above (`apps/web/e2e/assistant.spec.ts`: the probe artifact, the page policy alone, the foreign
  messages, Expand) run in each browser (`E2E_BROWSER=firefox` or `webkit`, one of Playwright's own
  builds: `pnpm exec playwright install firefox webkit`, then
  `E2E_BROWSER=firefox E2E_PROJECT=assistant pnpm run test:e2e --project=assistant --grep "the lawyer|generated artifact|running artifact"`
  from `apps/web`; the first of those specs sets the app up for the others). Checked on 2026-11-28 (Playwright 1.65.1:
  Firefox 159, WebKit 27.2); every check passed in all three:
  - an external script, stylesheet or image, and navigation of the frame, are not requested (the probe
    host, which answers when asked, is never reached; a control frame shows that such a request would
    be seen), nor is the frame's `fetch` to `/api/rpc`;
  - a script of the frame can't reach the parent's document or `localStorage`; the inline scripts of the
    artifact and of the bootstrap still run, under the page policy;
  - Run, Expand, links, prompts and foreign `postMessage`s behave as in Chromium.

  One difference, which holds nothing: reading `document.cookie` from the frame throws a `SecurityError`
  in Chromium and Firefox, and answers with an empty string in WebKit (the test sets a cookie the page reads and checks the frame gets
  nothing). CI runs Chromium only; the two other browsers run on
  request, locally, and a page that reloads under a navigation in them (a Vite dev server re-optimizing
  a module) is visited again (`visit` in the spec). Not covered by any browser's policy, and not tested:
  WebRTC, which is why an artifact runs only after a click.
- **First-run setup creates the initial owner.** Sign-up is disabled; `auth.setup` (public) creates the
  owner only while no user exists, and only with the one-time code from the server's settings
  (`DISPAND_SETUP_CODE`, random: `deploy/README.md`), so the first-run window can't be claimed from the network.
  Wrong codes are counted per client address (`X-Real-IP`, read as the sign-in throttle reads it)
  and in all: after 5 from one address, or 20 in all, every code is refused for 15 minutes from the
  first, the right one too, so changing address doesn't buy more guesses. The counts are each
  process's own, in memory, and a restart clears them, like the sign-in throttle's default store.
  **Accepted:** anyone who reaches the app can delay first-run setup by sending wrong codes; they
  can't guess a random code that way, and the owner can restart the app or close it to the network.
- **The app is reachable only through the reverse proxy**, which terminates TLS and sets
  `X-Real-IP` to the peer it saw, overwriting what the client sent. That header alone is the
  sign-in rate-limit identity, so nothing but the proxy may reach the app's published port 3000
  (`deploy/README.md`): anything else reaching it could choose its identity.
- **File downloads enforce the attachment's current scope and never run in the app's origin.** Each one's bytes are stored under its owner id and attachment id, both ids made
  by the server: nothing from the upload or the tool's result (name, type, URI) reaches the key (on the default local store, the path
  `<DISPAND_FILES_DIR>/<ownerId>/<attachmentId>`). The store is read only after the attachment's row; the sweep
  removes the names the store lists that no row has (an interrupted write's `<id>.tmp` among them). They are reachable only through the app, at
  `GET /files/<id>`, which checks the signed-in user on each request and answers 404 for inaccessible ids.
  A Job's file requires current access to that Job. Other readers can download only attachments
  carried in the structured files of a committed user message in that Job's transcript.
  A queued message publishes its attachments when dispatch or steering writes that transcript
  entry, independent of subsequent runner execution. Held drafts belong to the uploader;
  raw tool-result bytes remain available only to the Job's authorized owner. Table files require the parent
  table’s single-workspace owner access, including after a table adopts a Job file. Downloads use no-store. A file
  is an image only if its first bytes are PNG, JPEG, GIF or WebP; only those are served inline,
  with that type. Everything else, SVG and HTML included whatever their name or declared type,
  is a download (`application/octet-stream`). Every file gets `X-Content-Type-Options: nosniff`
  and `Content-Security-Policy: default-src 'none'; sandbox`. A cell only holds files of its own
  table. Files are at most 10 MiB. Agents get no file's content but the files a person attaches
  to a chat message ([runner.md](runner.md)): no tool or prompt carries one. A Job with the `data` bundle sees a row's file names and
  ids, and can set a files cell to files already uploaded to that table (or empty it, after
  which the unused files are swept), like any other value of the row. Files in the result of a
  Job's HTTP tool call (images, embedded resources' blobs; at most 20 a result, each with the
  same bounds and sniffing as an upload) are stored as that Job's, and the agent gets their ids
  in place of the bytes. So are the files a Job's runner tools return: the runner's MCP proxy
  sends them to `POST /mcp/job/files` with the Job's token, which names that one running Job, so
  a stdio server can't put a file in another Job, and the key stays the server's own
  (`<ownerId>/<attachmentId>`). A result is kept or refused whole, with the reason in its text
  (what the agent sees, and the Job's transcript): a file over 10 MiB, more than 20 files, the
  Job's totals (200 MiB and 100 files over every file it keeps, from any tool, a file a table took
  included) or the install's (its owner's setting, 10 GiB until set, over every attachment). The
  check and the store run under one install-wide lock, so two results can't both fit a total only
  one fits; the proxy checks the per-result limits before sending, and the endpoint takes one
  result's worth of body (about 268 MiB) and no more.
  A Job can write in a cell only its own such files that no table has
  yet, which then become that table's for good (`writeRow` takes the writer from the call, never
  from its input): never another Job's, nor one a person writes. The bytes are stored as the
  server sent them. A reader must have the download permission for the file's current scope.
- **Every input is validated** by its procedure's Zod schema, and refused before it and before
  the gates when any of its strings or keys holds a character PostgreSQL can't store (a NUL, a
  lone surrogate: `storable`, the runner protocol's rule), with `validation.unstorable` and that
  field's path, or when it nests deeper than 1,000 levels, which no procedure's input comes near
  (`validation.tooDeep`): `inputRefusal` (`rpc/context.ts`, run by `storableInput` in `base`, and
  by `callPlatformTool` before the reads a Job's tool call makes ahead of its procedure) walks it
  with its own stack of at most that many containers, so no input overflows it or makes it hold
  more, and none reaches a query; errors don't leak internals:
  anything but an `ORPCError` reaches the page as the generic message (oRPC sends no text, the
  log only `logError`'s summary), and so does an `ORPCError` with no message key (the page shows
  only keyed messages and text marked external), and a server message's values render as text, never markup. Text from outside stored in a failure column goes through `plainText`, so one shaped like JSON can never read as a stored message.
