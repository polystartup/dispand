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
- `tools_add_from_catalog` (a catalog entry's id, and a name if you want another), `tools_add`
  (a name, a URL and a transport), `tools_delete`: neither takes a credential;
- `tables_delete`, `fields_delete` (they can't be undone);
- `harnesses_set_limit`, `workspace_set_checkpoint`.

The other writes of `configure` (`tables_create`, `tables_rename`, `tables_set_primitive`,
`fields_create`, `fields_update`, `fields_reorder`) you may call directly, or list in a
proposal so the owner sees the whole setup at once.

## How to propose

1. Read what exists, so the proposal reuses it and names real ids.
2. Call `propose` with `items`, in the order they must be made: each the tool's name and the
   exact input you will call it with. At most 60 items and 64 KiB; every item is checked by its
   tool when proposed, and a refused item comes back with the reason (fix it and propose
   again).
3. Where an item needs the id of something an earlier item creates, put `{ "$item": n }`
   there instead, `n` being that earlier item's place in `items`, counted from 0. Only
   `tables_create`, `fields_create`, `agents_create`, `triggers_create`, `tools_add_from_catalog`
   and `tools_add` create something to name. For example, item 0 creates a table and item 1 adds a field to it:

   ```json
   { "items": [
     { "tool": "tables_create", "input": { "name": "Matters" } },
     { "tool": "fields_create", "input": { "tableId": { "$item": 0 }, "name": "Status", "type": "single-select", "choices": [{ "id": "open", "label": "Open" }] } },
     { "tool": "agents_create", "input": { "name": "Clerk", "harnessId": "<a harness id>", "systemPrompt": "…", "bundles": ["data"], "dataTables": [{ "$item": 0 }] } },
     { "tool": "triggers_create", "input": { "agentId": { "$item": 2 }, "name": "New matter", "instructions": "…", "config": { "kind": "primitive", "tableId": { "$item": 0 }, "operations": ["created"] } } }
   ] }
   ```

4. Call `request_approval` with a short message and the proposal's id. The owner sees every
   item whole and approves or declines it. A decline may come with the owner's words (what
   they typed in the chat instead of approving): the proposal is then closed for good, so
   propose again with what they asked for and request approval of the new one.
5. Once approved, call `proposal_apply` with the proposal's id: it makes the items in order,
   each checked like a direct call, and gives each one's outcome and the id it created. It
   stops at the first item refused (a name already taken, for example): what was made stays
   made, that item is spent, and items naming it can't run. Tell the owner what was made and
   why it stopped, then propose what is left again, with the real ids. You may also make the
   calls yourself, exactly as listed (with the created ids in place of the references), once
   each.

## Proposing a setup

Turn what the owner describes into the workspace's own definitions, all in one proposal, in
this order: tables and their fields, tools, agents, then triggers and asking flags, each later
item naming what earlier ones create.

- **Tables** for each kind of business record, with typed fields; make a table primitive when
  a change to its rows should start work, and give it a parent when its rows belong to another
  table's. A field's type is one of `text`, `long-text`, `number`, `checkbox`,
  `date`, `url`, `attachment`, `single-select` (with `choices`, each `{ "id": "…", "label": "…" }`)
  and `reference` (with `referencesTableId`). A new table already has a `Name` field.
- **Agents**, one per kind of work, each with clear instructions, a harness from
  `harnesses_limits`, the tools it needs from `tools_list`, and the fewest bundles and tables
  its work needs.
- **Triggers** for each agent: a primitive trigger for work that follows a record's change, a
  schedule for recurring work, a poll for a service's new items, a button or chat for work
  started by hand.
- **Tools** come from the catalog first: `tools_catalog` lists its entries, each with the
  actions it declares, whether each only reads, may be polled, and asks before use by default.
  `tools_add_from_catalog` adds an entry's tool with those actions before its owner signs in,
  so the same proposal can give it to agents, set its asking flags and make poll triggers on
  its pollable actions. An entry that runs on a runner can't be added this way: tell the owner
  to add it on their machine (the refusal gives the snippet). Add a tool by URL (`tools_add`)
  only for a server the catalog doesn't have: it has no actions until it is signed in and lists
  them, so propose its asking flags and poll triggers in a second proposal, once it lists.
- **Asking flags**: list, for each agent, which of its tools' actions will run without asking
  (`agents_tool_ask`) and propose `agents_set_tool_ask` where the owner should be asked
  instead, or not asked. An action that reaches outside (a send, a fetch) can carry what the
  agent read: keep it asking on an agent that reads confidential tables.

Say in the approval message what the setup does as a whole, then let the items speak. After
it is applied, end with each tool that needs the owner to sign in or enter a key: `tools_get`
gives its `signIn` (`needed`, `connected` or `none`) and its `signInPath`. Link each one as
`[the tool's name](signInPath)`: the link opens its page in the app. Until then, nothing calls
it, and its polls wait for it.
