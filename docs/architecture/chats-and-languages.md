# Chats, the slash picker and languages

### Continuing an ended chat

The scheduler checks for idle chats every 15 seconds. After a chat has been idle for 30 minutes,
the engine completes it and releases its session. An active turn, work awaiting delivery or an
unanswered question (including an approval) keeps the chat open. A workflow chat also stays
open while it owes outputs or has downstream steps to run. The deadline survives runner reconnects. On startup the same check runs before recovery, including for existing chats.

The transitions of a step that move several columns under one rule (its session replaced, its
chat continued, its end, its transcript gone) are `engine/step-lifecycle.ts`'s, each with its
guard (continuing a chat with its Audit row, span and stream events too); the engine calls them.

An owner can continue a chat in the same run after it ended: a Job chat that finished, failed
or was stopped, and a workflow run whose chat trigger is where it failed, stopped or finished.
Its definition identifies the chat step even when the harness failed before creating a session.
The owner's message and, for a Job, its fresh token and root and the `job.reopened` Audit row,
commit together. An explicit continuation checks current harness settings. A compatible session
resumes its transcript, unless the harness said it can't (an `error` event of kind
`cannot-resume`, protocol 34: the runner has no record of that CLI session in that folder, or
the resumed CLI failed before reporting anything). When no transcript can resume or the harness changed, the normal start path
creates a fresh session on the same step, told the conversation so far in its start prompt (the
newest turns that fit the prompt bound); the owner's messages since the agent's last answer go
to it again as messages, with their files. Its visible messages, attachments, and questions keep
their IDs. A failed workflow's steps after the chat that never started wait for it again; steps
that already ran, or a finished run's skipped branches, don't run again. A send racing a failure
keeps its draft for the owner to edit or resend. A message queued before a run failed or was
stopped fails rather than reopening it. Deleted agents stay closed. The runner must still be authorized for any session launched on
it.

Migration 0070 adds nullable `step_runs.resume_after_session`. It records the former session
and whether its process has ended, until the resumed start is written. Protocol 22 adds
`session-ended`: a requested stop acknowledges only after the CLI process exits and its
session files are cleaned up, or immediately when the process is absent. A logical `result`
can arrive earlier and proves no process exit. Events of the old session cannot affect the
new one. A reconnect that omits the former session also releases the resume; a reconnect
that finds the new session already live recovers that start. Recovery retains the pending
message and never launches two CLI processes against the same transcript. Before the new
session has started, a missing-session report never queues the previous conversation again.

The resume retains the run folder and CLI transcript id and carries undelivered new messages
through the existing resume prompt. Its start reads the fresh token and current permissions,
so tools removed since completion are absent. Cloud sessions inherit the previous model
items under their new id after the former loop has ended. Unanswered calls from the old
model batch are settled as interrupted before the new message is consumed; they never run
as part of that follow-up. The former token stays invalid.
The browser keeps watching continuable chats after success or failure, within its normal connection cap,
so the same composer can send and receive a new turn without starting another Job.

### Queued chat messages

An owner message sent while the chat's turn is under way (`turn_status` `running`), or while
messages wait before it, is not sent to the harness: `sendChat` records it in `chat_queue`
(migration 0089), `pending`, under the chat step's lock, with its held files taken for the Job
as a sent message's are. Once the chat is idle, `drainQueue` sends the oldest pending one, one
per turn: after `turn-end` and the other events that can leave a chat idle, after an interrupt
or a stop, and on boot. A dispatch locks the chat step, then the item (`FOR UPDATE`), checks it
is still pending and that no dispatched item awaits its acknowledgement, marks it `dispatched`
and writes the message under the item's own id in the same transaction, then sends it as any
message. The next `turn-end` acknowledges it (`acked_at`); until then the next item waits.
`runs.editQueued` and `runs.removeQueued` (the owner's only) change only a `pending` item (a
failed one can be removed), so an edit or a removal and the dispatch have one winner, refused
with `CONFLICT`; a removed item keeps no words, and its files go back to held (swept a day after they came). One that can't go (the chat stopped or can't be
reopened) is `failed` with its reason. A message sent while the chat is idle goes at once, as
before. `runs.get` and `runs.stream` carry the pending and failed items (`queue`, `queued`
events). Telemetry: an `engine.queue` span event (action, step id) on each enqueue, edit,
removal, dispatch, steer and failure; no words.

`runs.steerQueued` (the owner's only) sends a pending item now, into the running turn
(`HarnessAdapter.steer`, its item id as `requestId`). Its claim is the dispatch's, under the same
locks: the item must still be pending (else `CONFLICT`, as an edit's), and the chat's turn running,
not being interrupted, with a live session; an item that invokes a skill waits for the turn's end,
as its skill may replace the session. A refused one stays pending and goes at the turn's end. The
claim marks it `steering` and writes the message under its id; the harness then delivers it once
(every harness steers, attachments included). A `steering` item counts as in flight until its
`steer-result`: `steered` acknowledges it (before or after that turn's end); `queued` makes it
`dispatched`, the harness's next message (for Codex, the input of that turn, `codex_input_id`),
acknowledged by the end of the turn it starts, as the harness reports no end of the turn it
missed. One whose session is lost or ended, or whose write failed, is an ordinary message then:
`dispatched`, and for Codex undelivered, so the resume carries it. The step's view carries `steering` (`{ interruptsTools }`, from
`steering(harness)`) for an interactive step: the composer offers "Send now", or "Interrupt and
send" where steering stops the running tool (Claude Code), only on a pending item without a skill
while the turn runs; otherwise the item says it goes when the turn ends.

## Assistant slash picker

The Assistant composer requests `assistantCommands` while typing a leading `/` token. The
owner-scoped procedure reads the existing conversation's stored harness, or the Assistant's
current harness for a new chat. Protocol 25 adds correlated `commands.request`/`commands.replied`
messages. Live sessions use Claude SDK `supportedCommands()` or Codex `skills/list` in their
own context; new chats discover without a model turn. No local paths enter the browser catalog.
Codex exposes skills, not its built-in command menu. Discovery errors leave Dispand skills
available with an explicit warning. Names and aliases deduplicate native invocations; qualified
plugin skills remain distinct.

A selected Dispand entry carries its owner-scoped skill id. `jobs.start` loads it before the
new conversation starts; `runs.sendChat` resolves it again on submission. Explicit choices are
recorded in `snapshot.invokedSkills`, extending only this conversation's packages and their
required tools. They do not edit agent settings or automatically approve tools. An idle live
session resumes with refreshed packages; choosing a new package during a running turn is
refused until the turn finishes. Removing the installed package revokes server-side skill reads.
Claude receives its qualified slash invocation; Codex resolves an enabled skill locally and
sends a native skill input, preserving arguments. Cloud conversations use the existing
`read_skill` loader. Keyboard selection edits the draft; it never submits it.

A Codex thread keeps the dynamic tools it started with: the app-server protocol takes
`dynamicTools` on `thread/start` only, not on `thread/resume`, `turn/start` or `thread/fork`
(Codex 0.169). On a sandboxed runner (the container image, which says so in its CLI inventory,
`clis.sandboxed`, protocol 40) every tool of a session reaches Codex that way, so a chat that
resumes its thread after a skill brought it new tools would never see them. Until Codex takes
tools on resume, `runs.sendChat` refuses that choice (`engine.skillCodexTools`: start a new
chat) before anything changes, live or ended chat (a queued message fails with it once the chat
is idle, as one that can't go does): a skill that adds a tool to a Codex chat with a thread to
resume, on a sandboxed runner. Claude Code chats, Codex chats on a
bare runner (Codex reloads MCP servers on resume), a chat with no thread yet and a skill that
adds no tool reload as above. The sandboxed runner also refuses, for now, any start with skill
packages (`SANDBOX_UNSUPPORTED`), so this refusal matters once skills reach its workers. It goes
once the generated protocol's `ThreadResumeParams` takes `dynamicTools`:
`apps/runner/src/codex/resume-tools.test.ts` then fails typecheck, saying to pass them on resume
in `codex/session.ts` and remove the refusal (#244).

Native catalog entries retain their Dispand skill binding when matched, so selecting a native
workspace skill still loads its required Dispand tools. If discovery was unavailable, the runner
resolves a fallback package namespace through its verified native installation before dispatch.
Codex scope collisions share one identity mapping between catalog and input conversion. Global
action disables, tool retargeting, and skill/package removal narrow live sessions even when a
tool came only from an explicit conversation selection.

Native command bindings use verified installation source keys, never a matching command name
alone. The runner annotates catalog entries from its native inventory; the server compares
those keys with the stored plugin revision or workspace package digest before attaching a
Dispand skill id. An unrelated native command with the same invocation keeps precedence without
granting access to the unrelated Dispand package or its tools. A package the runner wrote into
the live session as files carries the key Dispand sent with it on its own `<package>:<skill>`
commands (a `~<hash>` name stays unbound), so choosing it again refreshes its required tools; a
package a native installation replaced at the start was never written, and binds only through
that installation. Exact Codex catalog identities also take precedence over compatibility
aliases, the runner's package aliases included: Codex applies one only when no catalog name
matches exactly. Protocol 25 covers command discovery and all
of these identity fields together; the intermediate commits were not distributed as releases.

## English and French

We decided that the page speaks English and French. `i18next` and `react-i18next` hold its
strings: one namespace per area in `apps/web/src/locales/<language>/` (`common`, `shell`,
`assistant`), plus
`messages`, the files the server and the page share (`packages/domain/src/messages/`). A key
missing in French shows the English text; `lib/i18n.test.ts` keeps both languages with the
same keys.

- **One instance per page render:** the root route's `beforeLoad` reads `getAuthState`, which
  gives the page's language: the signed-in user's saved one (Better Auth's
  `user.additionalFields.language`, column `user.language`, `"en"`, `"fr"` or null, the
  validator refusing anything else), else the request's `Accept-Language` ordered by quality
  with `q=0` dropped (`resolveLanguage`, `detectLanguage`: the first of English or French,
  otherwise English). The root shell makes its instance in that language (`createI18n`), so the
  first HTML and `<html lang>` are already in it, and the dehydrated context gives the browser
  the same language for hydration. Concurrent renders never share an instance.
- **The choice:** the user menu's Language (`LanguageChoice`, beside the theme) saves
  `language` through Better Auth's `updateUser` (`lib/auth-call.ts`) and reloads the route
  context, which switches the instance. "Browser's language" saves null.
- **Dates and numbers:** `lib/format.ts` formats them in the page's language (`useFormat`),
  never the browser's default locale.
- **Lint:** `i18next/no-literal-string` fails a user-visible literal (JSX text, `placeholder`,
  `aria-label`, `title`, `alt`) anywhere in `apps/web/src` (tests apart), so no area of the page
  is left untranslated.
- **Server messages:** an error whose text reaches a person carries a key of the `messages`
  files and its values, never a sentence: `new ORPCError(code, message(key, values))` or
  `new EngineError(code, message(key, values))` (`packages/domain/src/messages/index.ts`;
  `MessageKey` is every key of `en.json`). Each message is a whole sentence under one key, its
  values interpolated (`{{name}}`, plural forms by `count`), never assembled from pieces. The
  error's `message` stays the English sentence, for agents (a tool call's refusal) and the logs.
  The page's link (`lib/api.ts`, `translateErrors`) translates `data.key` in the page's language
  (`<html lang>`); text marked `external(text)` (an MCP server's, a plugin's) shows as it came;
  an error without a key, or a key the page doesn't know, shows the generic message, whatever its code. Values are text:
  React escapes them; a list value is formatted by the page (`Intl.ListFormat`). Person-facing text a
  procedure returns as data (an uninstall's reasons, an update's refusals, a setup's waiting
  definitions, why a cell value doesn't fit its field, a proposal's "of the table X", why a plugin's element isn't imported: `NotImported.reason` is a `Message`, so the compiler refuses a sentence; Zod's own messages inside a definition's "path: message" problem stay in English, the library's text) is a `Text`: `say(key, values)`, or `{ text }` for words that came as they are (a
  plugin's, another area's not yet keyed, `reasonOf(err)`); the page renders it with `useText()`
  (`lib/message.ts`). The same holds for what the workflow editor shows: a workflow issue
  (`WorkflowIssue.message`), a refused link (`connect`) and a schedule's problem (`cronProblem`) are
  keyed messages, which the procedures that refuse a save or a start throw as they are. So are the
  Assistant's guard reasons (`assistantGuard`), why a consult isn't allowed (`pairProblem`), what
  still holds a tool (`toolHolder`) and why a poll may not read an action (`pollProblem`): each
  returns a `Message`, and what stores one (a skipped poll's reason) keeps it as a stored message
  (`pollProblemText`). The engine's refusals are keyed too (`engine.*`); a checkpoint's Approval
  names its root by kind (`rootKind`), and the page has one whole sentence per kind, and a harness's proposal detail is a
  keyed message. The errors of the Git, marketplace, skill-site, plugin, tool, skill-package and
  model-listing readers (`GitError`, `MarketplaceError`, `WellKnownError`, `PluginError`,
  `ToolError`, `PackageError`, `ModelListError`) extend `SayError`: their constructor takes a key
  and its values, never a sentence, and `say` carries them. One leaving a procedure answers with
  its `code` (`BAD_REQUEST` unless its class says otherwise) and that message: the base middleware
  maps it (`rpc/context.ts`), so no call site does. What is stored for a person (a step's or a Job's failure, a
  fire's or a poll item's reason, a tool's `actionsError`, a marketplace's `syncError`) is a
  stored message: the key and values as JSON in the same text column (`stored(key, values)`),
  which the page renders in its language (`useStored()`, `storedText`). A row written before
  holds plain words, shown as stored; text that came from elsewhere (a runner's error event, a
  tool's own answer, git's own words) is stored as it came (wrapped by `plainText` when it looks
  like JSON, so it never reads as a stored message), or passed as a value of a keyed
  sentence. A tool result for an agent shows every such text as its English sentence
  (`sentence`, a tool's `filter`, `issues` for a refinement's key and its `params`), never a key. An input its Zod schema rejects answers with `validation.<code>` and the
  field's path and limits (`rpc/context.ts`, `validationKey`); one holding a NUL or a lone surrogate in
  any string or key, which PostgreSQL can't store, is refused before its schema with
  `validation.unstorable` and that field's path, and one nested deeper than 1,000 levels with
  `validation.tooDeep`, its path and the limit (`inputRefusal`, run by `storableInput`, and by
  `callPlatformTool` for a Job's tool call, which gets the English sentence). `messages/messages.test.ts` walks
  the domain for every `new ORPCError(` and `new EngineError(` and fails on one whose message
  isn't a single `message()` key, external text or an engine error passed on (`passOn(err)`, typed
  `EngineError`, always keyed: its constructor takes a `message()`), and for every saying error
  built with anything but a key given whole. Its list of exceptions is empty.
- Agent output, plugin texts and MCP servers' texts are shown as they came. Logs, telemetry and
  the code stay English.
