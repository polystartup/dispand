# The server, to its database, logs and telemetry

- **Telemetry carries no secret and no content.** One module knows OpenTelemetry's SDK
  (`packages/domain/src/telemetry/`; a lint rule keeps it so), and everything it exports goes
  through `redact.ts` first, whoever recorded it (our code, or a library's own spans): an
  attribute whose name is a secret's (`authorization`, `cookie`, `token`, `code`, `state`,
  `api_key`, `password`, `secret`) or a header is dropped; a URL keeps no query string,
  fragment or credentials; an exception keeps its kind only, never its message or stack; a
  span's status keeps no message; and any value equal to a secret the process opened (the
  secret box remembers a salted hash of each, never the plaintext) is dropped. Errors are
  recorded with `recordError` (the kind) and logged with `logError` (its whitelist). Spans and
  logs carry ids, names, counts, durations and result kinds, never a procedure's input or
  output; a metric keeps only the attributes `telemetry/metrics.ts` lists for it. Nothing is
  sent unless `OTEL_EXPORTER_OTLP_*` names a collector, and then only there. Log records are
  also printed to the process's output, through the same redaction.
  The HTTP server, the PostgreSQL driver and outbound fetch are instrumented by a preload
  (`apps/web/telemetry-preload.mjs`): no header is recorded; pairing (`/runner/pair`), the
  runner socket, OAuth callbacks and health checks make no span; a call out keeps only the
  origin it went to (a tool's address may hold a secret in its path); a statement is recorded
  without its values; a connection string keeps no password.
- **The server's secrets come from its environment** (`deploy/README.md`), never from git,
  logs or client bundles.
- **Secrets entered in the app (API keys, tool headers) are sealed at rest** with AES-256-GCM
  under `DISPAND_SECRET_KEY` (`packages/domain/src/secrets.ts`, random 12-byte IV), and the
  AAD names their table, row and field, so a sealed value copied elsewhere doesn't open. They
  are write-only: no procedure returns them, sealed or not, only whether one is set. A failure
  to open one is a `SecretError` whose message holds neither the value nor the sealed text.
  Each sealed value names its key by an id (a truncated HMAC of the key, which tells nothing of
  it), so the key can be rotated (`deploy/README.md`): the previous key, given as
  `DISPAND_SECRET_KEY_PREVIOUS`, only opens, and each start seals again under the current key
  every value it opens (`secrets-reseal.ts`), the plaintext never leaving the secret box and no
  value changing (so no Audit row). Without a lock, so that processes sharing a database start
  together: a row is rewritten only while it still holds the sealed text read. A value neither key
  opens is left as it is, never cleared, and counted in the start's log, which says whether the
  previous key is still needed. The steps: give every process the new key as `DISPAND_SECRET_KEY`
  and the old one as `DISPAND_SECRET_KEY_PREVIOUS`; once none runs the old settings, start one
  more and drop the previous key only if that start logs `secrets.reseal done`. A process still
  on the old settings seals under the old key, which an earlier "done" doesn't cover, and can't
  open what the new key sealed until it restarts. No process ever gets the new key as the
  previous one: its start would seal back under the old key. A process of a release before key
  ids opens none of the `v2` values a newer one seals, so processes sharing a database upgrade to
  it without overlapping older ones. **Accepted:** an edit already under way while that start runs
  (a tool renamed, a harness changed with its key kept) can write back the sealed value it read
  before, under the old key. So make that start while no tool or harness edit is under way or can
  begin: with no other process serving requests, say. A single app (`deploy/README.md`) serves no
  request before its start's pass is over.
