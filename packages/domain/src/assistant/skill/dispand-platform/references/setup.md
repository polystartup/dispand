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

- `agents_create`, `agents_update`, `agents_set_tool_permission`;
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
   why it stopped, then propose what is left again, with the real ids. When a name was taken,
   ask the owner whether to use what has it (`tables_list` gives its id) or another name. You
   may also make the calls yourself, exactly as listed (with the created ids in place of the
   references), once each.

## Proposing a setup

Turn what the owner describes into the workspace's own definitions, all in one proposal, in
this order: tables and their fields, tools, agents, then triggers and asking flags, each later
item naming what earlier ones create.

- **Tables** for each kind of business record, with typed fields; make a table primitive when
  a change to its rows should start work, and give it a parent when its rows belong to another
  table's: `tables_set_primitive` with `parent` adds the reference field to the parent itself,
  so don't create one. A field's type is one of `text`, `long-text`, `number`, `checkbox`,
  `date`, `url`, `attachment`, `single-select` (with `choices`, each `{ "id": "…", "label": "…" }`)
  and `reference` (with `referencesTableId`). A new table already has a `Name` field. A table
  only a primitive trigger watches must be primitive.
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
  its pollable actions: an entry's `poll` gives such a trigger's `action`, `arguments`,
  `itemsPath`, `idPath` and `continuation`, to copy into its config as they are. An entry that runs on a runner can't be added this way: tell the owner
  to add it on their machine (the refusal gives the snippet). Add a tool by URL (`tools_add`)
  only for a server the catalog doesn't have: it has no actions until it is signed in and lists
  them, so propose its asking flags and poll triggers in a second proposal, once it lists.
- **Action permissions**: `agents_tool_ask` lists each chosen tool's actions with permission
  `run`, `ask`, or `off`. Propose `agents_set_tool_permission` with a literal `action` name and
  `permission` to change one. Off actions cannot run; re-enable with `ask`, and use `run` only
  for an explicit grant. An agent update keeps retained tools' permissions; an unasked list
  cannot restore an Off action. Changing a permission and then updating the agent in the same
  proposal preserves that permission. An action that reaches outside (a send, a fetch) can carry what the
  agent read: keep it asking on an agent that reads confidential tables.

- **The business itself**: until the workspace has a memory, keep what the owner told you about
  the business in your own instructions, so later conversations start from it. End the
  proposal with an `agents_update` of yourself (`agents_list` names you, `agents_get` gives
  your current input): your name, harness, model and tools as they are, your skills as they are
  (the platform skill can't be removed), and your instructions with a few lines on how this
  business works added.

Give every proposal of a setup the same `plugin`: the business or use case's name, such as
"Acme Law". Once applied, what its items created is listed in the workspace's plugin
"Generated: Acme Law", so the owner finds the whole setup in one place.

Say in the approval message what the setup does as a whole, then let the items speak. After
it is applied, write a closing message to the owner, before anything else: what was made, and
each tool that needs the owner to sign in or enter a key. `tools_get` gives its `signIn`
(`needed`, `connected` or `none`) and its `signInPath`. Link each one as
`[the tool's name](signInPath)`: the link opens its page in the app. Until then, nothing calls
it, and its polls wait for it. Only once that message is written may you end the chat with
`submit_outputs`: ending it never replaces the message.
