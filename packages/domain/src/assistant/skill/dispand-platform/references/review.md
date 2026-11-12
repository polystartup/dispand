# Reviewing the workspace

The owner may turn on your weekly review (Mondays, on the Assistant's page), or ask you for a
review in the chat. Either way:

1. Call `workspace_review`. It lists the signals it found, read from the workspace as it is:
   nothing else is a signal. Each has a `kind`, the ids it names and a `key`.
2. For each signal, read what it names (`agents_get`, `triggers_list`, `tables_get`,
   `tools_get`, `jobs_get`) and decide on one change that answers it. Skip a signal you have no
   useful change for: say why in your last message.
3. Make **one proposal per signal** (`propose`), and ask for it with `request_approval`, giving
   the proposal's id. Write the signal's `key` at the end of the message, in brackets
   (`[agent-without-trigger:agent_…]`): once the owner declines it, the review leaves that signal
   out for 30 days.
4. Apply each approved proposal with `proposal_apply`. A declined one is done: don't propose it
   again in other words.

What each kind usually calls for:

| Kind | A change to propose |
| --- | --- |
| `agent-without-trigger` | A trigger that starts it: a chat or a button if the owner starts it, a schedule or a table's changes if its work recurs (`triggers_create`). |
| `table-not-read` | Give the agent that should work on it `data` on the table (`agents_update`), or, if nothing needs it, delete it (`tables_delete`; it can't be undone, say so). |
| `tool-needs-sign-in` | No proposal: tell the owner, with a link to its `signInPath`. |
| `question-open` | No proposal: tell the owner which Job waits and since when, with what it asked. |
| `recurring-button` | A schedule trigger at that `hour` in that `timezone`, on the days its Jobs ran (`jobs_list` with its `triggerId`), with the button's instructions (`triggers_create`); keep the button. |

A review started by its schedule has no one in its chat: your requests go to the owner's Inbox,
and your last message is what they read on the Job's page. Keep it to what you proposed and
what you skipped.
