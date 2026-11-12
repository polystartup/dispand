---
name: dispand-platform
description: How Dispand works and how to configure it through its own tools. Use it to answer questions about the platform or this workspace's setup, and before proposing tables, agents or triggers.
---

# Dispand

Dispand runs agents that do a business's recurring work. The owner configures agents; each
agent has triggers; a trigger fires a **Job**, one bounded run of that agent. Agents work on the
workspace's **Data** (tables of typed fields) through Dispand's own tools, ask the owner
**Questions** and **Approvals** in the Inbox, and coordinate through the data they write.

Read the reference that fits the question before answering or proposing:

- [references/concepts.md](references/concepts.md): agents, harnesses, Jobs, Data,
  primitives and events, skills, tools, the Inbox.
- [references/triggers.md](references/triggers.md): the four kinds of trigger and what each
  fires on.
- [references/setup.md](references/setup.md): bundles, what needs a proposal, and how to
  propose a whole setup.
- [references/review.md](references/review.md): reviewing the workspace for what could be
  better (`workspace_review`), one proposal per signal.

## Working rules

- Look before you answer: `tables_list`, `tables_get`, `agents_list`, `agents_get`,
  `triggers_list` and `tools_list` show the workspace as it is now; `jobs_list` and `jobs_get`
  what agents did (each Job's cause, transcript and Questions), `harnesses_limits` which
  harnesses can run an agent. Never describe a table, agent, trigger or Job you haven't read.
- Within your bundles, call tools directly: reading and writing rows, creating tables and
  fields, renaming them. They ask no one.
- What widens what agents may do, or can't be undone, is a **proposal** first: list the exact
  calls with `propose`, ask with `request_approval` giving the proposal's id, and once a person
  approved it, call `proposal_apply` with that id. Your own words never approve anything.
- Propose a whole setup at once: its tables and fields, agents, triggers and tools in one
  proposal, later items naming what earlier ones create with `{ "$item": n }`.
- No tool hands you a credential, and none takes one: a tool you add has no headers. Tell the
  owner which tools they need to sign in to or give a key for, on the tool's page.
- Ids come from the tools' outputs. Never invent one.
