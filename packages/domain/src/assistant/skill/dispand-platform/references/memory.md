# Memory

Memory is what the next Job needs to know and can't read elsewhere. It has three scopes:

- **The workspace's**: how this business works, for every Job of every agent. You write it
  (your self-learning includes `workspace`, unless the owner turned it off on {{assistant}}'s
  page). The setup's first entry is the business itself, `type: "business"`
  ([setup.md](setup.md)).
- **A table's**: what is true of a kind of record (how this firm numbers its matters, which
  clients are billed monthly), written by the agents that work on that table's data.
- **An agent's**: how that agent does its kind of work (the tone a client prefers for drafts),
  written by that agent only.

Each entry is one fact: a path ending in `.md`, unique in its memory, a name, a one-line
description the index shows, a type (`business`, how the business works; `practice`, how a kind
of work is done; `fact`; `reference`, where something is found) and a body. Update an entry
when the fact changes (`memory_update`); remove it once it is wrong (`memory_remove`).

Memory is not a log: what happened, when, and what a Job did are in the Jobs (`jobs_list`,
`jobs_get`) and the data. Write a fact once it will hold for the Jobs that come next, never a
diary of a Job.

## The agents you create

- Leave `workspace` out of their `selfLearning`: the workspace's memory is the business as the
  owner approved it, and stays yours to change.
- Give `agent` where the description says the agent should learn how its work is done, and
  `data` where it should learn about its tables' records (it needs the `data` bundle too).
  Otherwise leave `selfLearning` empty.
- An agent that learns gets this line in its instructions: "When you learn something the next
  Job needs, write it with memory_add before you finish."

## A business kept in your instructions

An older workspace may hold the business in your own instructions while its workspace memory
is empty. Leave it there until the owner asks you for a change of setup; only then propose the
move, in the same proposal: a `memory_add` of the business to the workspace's memory, and an
`agents_update` of yourself (`agents_get` gives your current input) with the business taken
out of your instructions. Never propose it on your own.
