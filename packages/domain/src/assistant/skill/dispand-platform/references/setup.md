# Configuring the workspace

## Bundles

What an agent's Jobs may do through Dispand's tools is its **bundles**, over all tables or a
list of them:

- `data`: list, read, create, change and delete rows of its tables.
- `configure`: create and change tables and fields, make a table primitive, read agents,
  triggers, tools and harnesses, and propose what needs a person (below).
- `inbox`: read and answer other agents' open Questions (never Approvals), and be started by
  them.

A call outside the Job's bundles or tables is refused.

## What needs a proposal

These calls run only as an item of a proposal a person approved, in the same Job:

- `agents_create`, `agents_update`, `agents_set_tool_ask`;
- `triggers_create`, `triggers_update`, `triggers_delete`;
- `tools_add` (a name, a URL and a transport, no credentials), `tools_delete`;
- `tables_delete`, `fields_delete` (they can't be undone);
- `harnesses_set_limit`, `workspace_set_checkpoint`.

Everything else in your bundles you call directly.

## How to propose

1. Read what exists, so the proposal reuses it and names real ids.
2. Call `propose` with `items`: each the tool's name and the exact input you will call it
   with. At most 20 items and 64 KiB; every item is checked by its tool when proposed, and a
   refused item comes back with the reason.
3. Call `request_approval` with a short message and the proposal's id. The owner sees every
   item whole and approves or declines it. A decline may come with the owner's words (what
   they typed in the chat instead of approving): the proposal is then closed for good, so
   propose again with what they asked for and request approval of the new one.
4. Once approved, make each call exactly as listed (same tool, same input), once each. A call
   that differs, or one made twice, is refused.

An item can only name what exists when it is proposed. To set up something new from nothing,
propose in rounds: first create the tables and fields directly (no proposal needed), then
propose the agents, read their ids once created, then propose their triggers and the actions
of their tools that should run without asking.

## Proposing a setup

Turn what the owner describes into the workspace's own definitions:

- **Tables** for each kind of business record, with typed fields; make a table primitive when
  a change to its rows should start work, and give it a parent when its rows belong to another
  table's.
- **Agents**, one per kind of work, each with clear instructions, a harness from
  `harnesses_limits`, the tools it needs from `tools_list`, and the fewest bundles and tables
  its work needs.
- **Triggers** for each agent: a primitive trigger for work that follows a record's change, a
  schedule for recurring work, a poll for a service's new items, a button or chat for work
  started by hand.
- **Tools**: list, for each agent, which of its tools' actions will run without asking
  (`agents_tool_ask`) and propose `agents_set_tool_ask` where the owner should be asked
  instead, or not asked. An action that reaches outside (a send, a fetch) can carry what the
  agent read: keep it asking on an agent that reads confidential tables.

Say in the approval message what the setup does as a whole, then let the items speak. After
it is applied, tell the owner which tools need them to sign in or enter a key, on each tool's
page.
