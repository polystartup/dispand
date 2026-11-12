# Triggers

A trigger belongs to one agent and says what starts its Jobs and what the agent is told then
(its `instructions`, added to the Job's prompt). `triggers_list` gives an agent's triggers.
Every trigger has a `name`, `instructions`, a `concurrency` (`parallel`, or `one-at-a-time`:
a time that comes while a Job of the trigger is going is skipped) and a `config` of one of four
kinds:

| Kind | `config` | Fires when |
| --- | --- | --- |
| `manual` | `{ "kind": "manual", "placement": "chat" }` or `"button"` | The owner opens a chat with the agent, or presses its button. A button's instructions say what the agent does; a chat starts with the owner's words. |
| `schedule` | `{ "kind": "schedule", "cron": "0 8 * * 1", "timezone": "Europe/Paris" }` | The cron expression falls due in that timezone: an IANA zone named after a city, the owner's own (the one your instructions name when they chat with you, else ask). A time missed while Dispand was down fires once when it is back. |
| `primitive` | `{ "kind": "primitive", "tableId": "…", "operations": ["created", "updated"], "fields": ["…"] }` | A row of that primitive table is created, updated (a change to one of `fields`, or any field without them) or deleted. With `"tableId": "interaction"`, a Question or Approval is created, answered or expired (no fields). |
| `poll` | `{ "kind": "poll", "toolId": "…", "action": "…", "arguments": {}, "itemsPath": "…", "idPath": "…", "interval": 300 }` | Every `interval` seconds (60 to 86400) the server calls the tool's action with `arguments` (`{{lastPoll}}` stands for the time of the newest item found), takes the list at `itemsPath` and starts one Job per item whose `idPath` it hasn't seen. |

The Job is told what fired it: a primitive trigger gives the operation, the row's id, the
changed fields and their values before and after; a poll gives the item.

What a trigger reads, its agent must be allowed: a primitive trigger's table must be one of
its agent's tables with `data`; one on `interaction` needs the `inbox` bundle. A poll calls only
an action the owner lets polls read, and that runs without asking for every agent holding the
tool.

A primitive or poll trigger starts at most `rateCap` Jobs an hour (60 by default); events and
items past it wait their turn.

Creating, changing or deleting a trigger is a proposal item (see setup.md).
