# Tool permissions and plugin updates

Runner protocol 14 introduced runner-tool `unasked` actions and `session.permissions` updates. Both CLI harnesses derive MCP tool names locally. Updates can only remove grants; reconnect reconciliation sends current restrictions before further delivery. Owner action changes fan out to live Job and workflow sessions. Migration 0062 fills empty catalog runner-tool lists from the catalog defaults.

Runner MCP aliases are hashes of the tool id, runner id and local server key. They survive renames and other tools’ removal, and change on retargeting. Pending persistent answers are checked against the current binding and permission before delivery; permission updates invalidate local caching of older approvals. Updates arriving during skill fetching narrow the start before CLI launch. Automatic runner calls share the poll path guard for protected machine and session configuration.

"Let Stem deal with it" keeps each conflict handed to Stem in `plugin_conflicts` (migration
0075): one field of one of a plugin's agents, tools or triggers, with `mine` and `next`, the two
values it was handed off against. `plugins/resolve.ts` decides: `decide` applies a decision
only while the field is still `mine` and the element's `upstream` for it still `next` (else the
conflict is `open`, the owner's again); a reset takes the plugin's value; a decision applies at
once when its value is `mine` or `next`, except a change to an agent's rights (bundles, tables,
tools, skills, self-learning, consults), which combine and so always wait; anything else waits in
`merged` for the owner's Approval. We decided on one Approval in the Inbox per update: when the
Stem Job ends (`closeStemJob`, from the engine's end of run), its conflicts waiting in `merged`
become one `questions` row (an Approval of no step, its payload's `toolName` `plugin_update`,
so one push per update), whose items are the conflicts of that `runId` still waiting. Each item
is answered on its own through `plugins.resolveConflict` (`answerConflict` applies a yes, drops a
no as "Keep mine"), with the same check; the engine refuses a whole answer. The Approval is
answered once its last item is, and expires when the last leaves otherwise (`settleApprovals`,
which locks the Approval's row before counting its items, so two removals at once still close it).
A decision of Stem's writes only while the conflict is still Stem's: one landing after its Job was
stopped writes nothing.
The element's page links to it (`approvalId`). A later kind of conflict feeds the same Approval
by keeping its rows in `plugin_conflicts` with the Job's `runId`. The write holds only while the field still has the owner's value: the element's update checks
`context.expectField` (server-owned) under its row lock, or in its write for a tool, and a save
that got there first refuses it and reopens the conflict. A tool an agent gains by a decision starts with every action on Ask. Each
decision is an Audit row (`plugin.decided`: the element, the field's name and the decision's
kind, never a value). An update reopens the pending conflicts of the fields whose plugin value
it changes (`reopenChanged`), and an element that leaves the plugin drops its conflicts
(`forgetConflicts`). Writes go through the element's own update (`plugins/write-field.ts`, which
`resetOverride` uses too). On the update's screen, a skill's file (a wording change or a
conflict) names every agent whose sessions get the package (`reaches`, under the screen's token),
and a tool's new address or transport says what it clears (its sign-in, and its saved headers
when the origin or the transport changes). A skill package an agent gains is shown whole beside the change
(`gained`: each file's text), also under the token, since all of it reaches the agent. A field removal or type change names the workflows whose data step writes or filters on the
field (`stops`, from `workflowsUsingField`: a current version, or one a run is still on): a
removal stops them, a type change may. A table change that takes values away (a field removed, a type or choice change that drops
some) puts a digest of that field's values in every row under the token too (`TablePlan.values`):
a value written after the screen was read refuses the update, and the screen is read again.
The read and the field operation aren't one transaction (the operation runs its own), so a write
landing within the same call is the gap left. The update's screen offers "Let Stem deal with it" on a field of an
agent, tool or trigger, or on a skill's file: `plugins.update` takes those keys (`stem`), keeps them as conflicts and
starts one Job of the Assistant (`handToStem`, a `stem` firing with no trigger, its conflicts as
the trigger node's data). Its snapshot is limited (`only: ["plugin_decide"]`, and no skill, tool,
bundle, memory or consult; `withMemory` gives it no memory to read either, since it holds no
`configure` to filter what other agents wrote by), and `allowed` gives a limited Job those tools and no other, so the
Job server and the cloud listing offer `plugin_decide` alone; a call of another tool is refused.
`plugin_decide` takes only the Job's own conflicts and goes through `decide`. When the Job ends,
however it ends, what it didn't decide is `open` again, and what waits becomes its Approval (`closeStemJob`, in `finishRun`). On a
runner, the start says `restricted` (runner protocol 26), and the runner enforces it from its own
start arguments: on Claude Code, no built-in tool (`tools: []`, and the CLI's server-side
`advisor` switched off with `CLAUDE_CODE_DISABLE_ADVISOR_TOOL`, since neither `tools` nor
`disallowedTools` removes it), no settings source,
`strictMcpConfig`, no skill package, memory file or consult, and the Job's own `job` server
alone; on Codex (`codex/config.ts` `RESTRICTED`, checked with 0.171.0), the same, with
`submit_outputs` its only dynamic tool, every native tool a switch removes turned off through
`features` and config keys, every MCP server of the user's config set `enabled = false` (their
names from `config/read`), a read-only profile without network, and `environments: []` on every
`turn/start`, so the `apply_patch` the model's catalog entry adds (no switch removes it) fails
before touching a file. `codex/restricted-tools.test.ts` runs the machine's Codex against a
stand-in Responses API and checks every tool the model is offered; the runner refuses a
restricted Codex start below `RESTRICTED_MIN_CODEX` (0.167.0) and warns on any version but `RESTRICTED_CODEX` (0.171.0, where it was checked), until that test
is run again on the new version (runner protocol 29: an older
runner refuses restricted Codex starts and shows as outdated). A start that fails fails the Job,
and its conflicts are the owner's again. On the element's page (`StemMarks`, from
`plugins.conflicts`), each conflict says where it is: Stem is looking; Stem's merged value waits
for the owner in the update's Approval, in the Inbox, which the page links to (`approvalId`, once
the Job ended) and where each value is accepted or declined (`plugins.resolveConflict`,
`answerConflict`, with the same check); or it is theirs again, with the three choices of the update's screen (keep
theirs, take the plugin's, or hand it to Stem once more against the values as they are now).

A skill's file in conflict can be handed to Stem too: we decided it is a wording field like any
other, its merged text going to the update's one Approval. Its conflict is `kind: "skill_file"`
(no migration: `kind` is plain text), the skill package's id and field `file:<path>`; `mine` and
`next` are the owner's file and the plugin's, whole (the screen cuts a long one, so the update
hands Stem the full texts, `skillValues`, outside the screen's response), as their text, or for
a file that isn't text its size and digest, or null for none. The Job gets the three texts. A
reset takes the plugin's file as the package keeps it (`skill_file_upstream`, the same file
`resetFile` writes back; none when the plugin has none); a merge is the file's whole text (any
other value is refused, and so is one the package's check refuses, checked when Stem decides
(`checkFile`) and said by `plugin_decide`), and
applies at once only when it is one of the two files, else it waits in the Approval. Each of
`decideFile`, `answerFile` and the owner's "take the plugin's" is one transaction with the
package locked `for update`, the lock every file edit and the update take: the file and the
plugin's are read again (another value makes it `open`, the owner's again), the conflict claimed
(an Approval's item only as the owner answered it), then the file written through `putFile`,
which checks the package whole; a refusal rolls the claim back. An update that changes the
plugin's file reopens a decision waiting on it (`reopenChanged`). The skill's sheet shows
`StemMarks` for its files (`plugins.conflicts` with `kind: "skill_file"`).

A plugin's table can be handed to Stem too, whole: on the update's screen its "Let Stem deal with
it" box leaves its change boxes to Stem (`stem` takes `table:<id>`, refused with ticks for that
table). The update applies nothing of it and leaves its `definition` as it was merged, and
`handToStem` keeps one conflict for it (`kind: "table"`, field `changes`, no migration: `kind` is
plain text): `old` the definition it was merged with, `mine` its fields then, `next` the plugin's
definition with the changes shown. The Job is given each change by key with its kind, field,
whether it applies and how many rows would lose values, never a row's value. `plugin_decide`
takes a list of keys (a reset: every applicable one); any key the screen didn't show as
applicable refuses the whole decision, which applies nothing. `decideTable` plans the table again
(`plugins/table-apply.ts`, shared with the update and the plugin row's Apply) from the
definition it keeps to the plugin's current one, which must still be the two the conflict holds
(else an update merged it again and the conflict is gone); a key whose change is stale by now is
skipped. A change that removes values (a field removed or retyped, choices dropped), whatever the
row count, waits in the update's Approval with its field's values (`merged`: how many rows hold
one, the first 50 with their row ids to show, a digest of all); the rest apply now through the
field operations, and one an operation refuses (the field limit, say) is in `plugin_decide`'s
result (`refused`, by key and reason) and stays offered. The definition the table keeps takes
what Stem decided and declined, but keeps what waits or was refused as it was. What Stem leaves
out counts as declined, as an unticked box. The Approval's answer (`answerTable`) is one
transaction with the table locked `for update`, the lock every field operation takes and a row's
write takes `for share`, so nothing lands in between: it plans the changes again against the
definition the table keeps (an update that merged it since leaves nothing), claims the item
(deleted only while still in `approval` with the `merged` the owner answered on), and on a yes
reads the values again (another digest stores the values now, rolls the claim back and asks
again, CONFLICT), then runs each change's field operation in that transaction (`removeFieldIn`,
`retypeIn`, `updateFieldIn`, the bodies `fields.delete`, `fields.retype` and `fields.update` run
under their own lock), each in a savepoint. A change that went stale meanwhile (the field retyped
or its choices edited since) is skipped and declined; one its operation refuses stays out of the
definition, offered again; both are in `resolveConflict`'s answer (`stale`, `refused`), which the
Inbox item says. A no declines the Approval's changes as an unticked box; the plugin's row still
offers each with Apply. Either way only the Approval's changes are answered (one that failed
earlier stays offered). The values shown are the field's as they are: a choice change or a
retype may keep some. A table conflict is never `open`: when the Job ends without deciding it
(`closeStemJob`), it is dropped, and since the definition still lacks its changes, the next update
offers them again as the checklist, with their loss as it is then. Every update that plans a
table drops its pending conflict (`forgetConflicts`), so an old decision never applies onto a
table merged since. The element pages have no Stem mark for tables: the update's Approval is
where a table's decision waits.

Native support currently requires `plugins.native_root = '.'`, recorded from the resolved Git
checkout when importing or updating. Legacy rows have null until updated. Nested imports are
reported as unsupported for native installation because Skillshare cannot reproduce their
identity from the stored marketplace entry alone; they continue to supply workspace skills.

A native install follows its plugin's updates (`plugins/native.ts`): `updatePreview` names the
harnesses holding `dispand-<plugin id>` enabled and settled on each online runner, which stops
the update on its screen; an install disabled or mid-change there, and a runner that couldn't be
asked, are named as staying as they are. `update` moves only the harnesses the screen named
(`native`, which requires the screen's `reviewed` token and so its commit) that still hold it,
through `runners.workspacePlugin`: remove then add at the new commit, each previewed then
applied. A disabled install is never moved, so it stays disabled. Nothing of the owner's is kept
there: the native copy is never overridden. A shown harness that couldn't be moved, one holding it
that wasn't shown, and any when a Job updated the plugin, are returned in `leftBehind`; the update
stays applied, and the install is finished from that harness's workspace skills. An install made
in the native client under another name isn't Dispand's and doesn't follow.


Runner protocol 18 adds optional runner-action `denied` lists to session starts and permission
updates. The runner accumulates denials and blocks all actions of a removed server. Both native
harnesses check the same state before automatic approvals and again after a pending answer;
initial denials also configure native tool filters. Updates received during asynchronous startup
narrow its refs before native MCP configuration is rebuilt. Later messages cannot re-enable an
action or server in that session; a new session uses the current configuration. This protocol
support enforces the agent page's Run / Ask / Off controls. `agent_tools.denied` is retained
alongside `unasked`; HTTP tooling filters denied actions before listing or calling them. The
owner's `agents.setToolPermission` chooses the mode and fans narrowing out to sessions;
remembering an approval checks under the same row lock that the action is still enabled.
Agent setup proposals replay earlier permission items when freezing their unasked lists, and
an agent update cannot use a frozen grant to restore an action that is currently Off.

The permission write is `agents_set_tool_permission` with `permission: run | ask | off`, replacing
the earlier `agents_set_tool_ask` boolean input. Pending proposals using the earlier tool name
must be proposed again; their grants are not translated implicitly.

Workspace-wide tool availability lives in `tools.disabled`, separate from each agent's
Run/Ask/Off lists. Catalog defaults seed it at installation; discovery never replaces it.
`tools.setActionEnabled` is owner-only and excluded from Job tools. Tooling filters disabled
names before producing cloud specs, the Job endpoint, and runner permissions. Disabling
fans out to live Job and workflow sessions, including skill-only holders. Tool executors
re-read availability for cached calls, and poll validation reports disabled actions without
calling them. Availability changes increment the permission revision used by frozen setup
proposals. Re-enabling preserves per-agent settings; native sessions remain monotonic.

Remembered tool-approval storage and answer delivery share one transaction. A question's
nullable `remember` offer binds scopes to a server-resolved tool action and target revision;
`runs.remembered` holds disjoint allow/deny lists, initially empty. `agents/remember.ts` checks
the pending question, owner, run and current tooling inside the answer transaction before
storing a run decision or changing the Job agent's saved permission. Tool subjects include the agent id and a
target fingerprint so a remembered decision cannot cross agents or follow a retargeted tool. The owner-facing controls use the server offer; CLI rule subjects remain a separate integration.

Effective tooling combines a run's matching decisions with the agent's current permissions,
after restricting the tool set to current access and the Job snapshot. Denies take precedence;
a remembered allow applies only to a currently listed action. The tools endpoint and cloud
caller use these permissions at each call; runner starts, updates and resumes receive the same
restrictions. Live permission updates only narrow the current grant ceiling; a newly approved
allow must be delivered through the owner-answer path. Workflow runner sessions receive run-only allows, while their per-agent Run
settings retain their existing Job-only behavior. New owner answers populate run memory;
legacy MCP Always is refused in favor of an explicit scope. A cloud offer is resolved through
its persisted pending tool key, and a native offer through the session's server binding.
Claude normalization is shared with the runner; ambiguous aliases offer no remembered grant.

`runner-protocol/rules.ts` defines a pure parser and matcher for Dispand's native CLI rule
subset. Both CLI brokers use it for native permission snapshots. Claude rules cover selected
tool names, exact Bash commands, literal-word Bash prefixes
and exact WebFetch hostnames. Codex rules cover FileChange, exact shell commands and a proposed
execpolicy prefix. A Codex prefix additionally requires the identical proposed amendment and
exactly one command action. Prefixes accept only ASCII literal words separated by spaces or
tabs; shell syntax, expansion and quoting require an exact rule. Exact commands compare the
entire string, including any shell syntax. Rules never become native CLI settings or executable
expressions, and matching never substitutes for runner roots and denied-file checks. This
application-specific subset needs no shell parser: it deliberately does not interpret shell
syntax. The pure helpers emit no telemetry or rule text; operational consumers remain responsible
for bounded permission outcomes through the existing session and question events.

Migration 0069 adds `agents.cli_rules`, initially an empty list of CLI, rule and Allow/Deny
decisions. The owner-only `agents.cliRules` and `agents.removeCliRule` procedures list and
remove these entries; they explicitly reject Job contexts and are absent from the Job tool
catalog. General agent get/list responses omit the rules. Removal locks the agent row and
updates only its rules, so concurrent removals and general agent edits cannot restore a removed
entry. The agent editor manages this list independently from its Save button and says removal
takes effect at the next session start. RPC middleware traces outcomes without rule content.
Native Job approvals bind a supported rule to the stored agent and CLI. Only the owner may
save a scope that the server offered; native workflow and cloud questions have no CLI rule scope.

Protocol 21 carries native `rules.allow` and `rules.deny` snapshots (at most 200 each, bounded
rule strings), only with a Job token. The CLI adapter reads the agent's current entries for the
session's CLI at each start and resume, dropping unsupported shapes. The brokers parse them
again into session-local policy; Claude denials win, and boundary checks precede any native allow.
Claude enforces these through PreToolUse as well as canUseTool, including calls otherwise
auto-approved by the SDK. Codex checks extra permissions, repeat sandbox requests and edit
paths before accepting a matching grant. Neither broker installs native wildcard rules or
execpolicy amendments. Wrapped shell commands, quotes and expansions use exact command rules.

The current Codex integration can run known-safe commands without an approval callback.
It therefore cannot enforce these denial rules across every execution path. A Codex snapshot with a supported denial is
refused before its binary starts; a scoped native denial ends the session. No denial is silently
treated as enforced. Native Codex Allow memory remains supported. The server and UI offer remembered Allow only for Codex; Deny applies to the current call.
This restriction can be revisited when Codex provides a reliable denial enforcement path.
PreToolUse hooks can reject supported calls but fail open on errors and timeouts, so they are
not used as a denial boundary (see the [OpenAI Hooks documentation](https://learn.chatgpt.com/docs/hooks)).

Permission questions can carry a bounded `remembers` candidate checked against their call.
Only supported addRules suggestions are considered; otherwise a bounded exact command or
native tool/domain rule is offered as candidate data. The sanitizer preserves it whole or
refuses the question. An explicit scoped answer can cache that matching rule in this session,
without writing CLI settings (Codex accepts remembered allows only). The server binds each candidate to the active Job's stored CLI and agent, shows the rule
whole, and writes run-only or future-run memory in the answer transaction. A remembered
Codex denial is refused even if a client submits one directly. The CLI adapter merges
current agent and run rules at each start/resume; unsupported entries are dropped, duplicate
allows are merged, and denial overflow refuses the start rather than omitting a denial.
An undelivered answer is checked again: a removed grant loses its cache scope. Existing server authorization and telemetry
for managed MCP approvals are unchanged. `native-permissions.ts` is pure policy code with no
I/O or content telemetry; the operational paths retain their existing session/question events.


