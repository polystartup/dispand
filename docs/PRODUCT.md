# Dispand

Status: Prototype

- **What it is:** an open-source, event-driven platform for running agents and automating work
  across any business domain. Users configure agents that act on business data, respond to
  events, run on schedules or handle manual requests, and stay involved by answering the
  agents' questions and approving their actions.
- **What it does today:** a web app where the owner assembles agents from harnesses (Claude
  Code and Codex CLI sessions run by the owner's own runners, or model APIs called by the
  server), skills and tools (MCP servers), gives them memory in data tables, wires them into
  workflows that run by hand or on a schedule, and works with them from dashboards. Plugins
  bring skills, agents and tools from Git repositories and skill sites.
- **For whom:** a single owner per install who wants to hand recurring business work to AI
  agents, whatever the business: a law firm, a software studio, a shop.
- **Direction:** agents own their triggers (data events, polled services, schedules, manual
  requests), each firing a bounded Job, and coordinate through business data, events and
  memory.
- **Product rules** (owner decisions, cheap to change):
  - A schedule that falls due while Dispand is down fires **once** when it is back, for the
    latest missed time, never once per missed time.
  - A schedule that falls due while a run of the same workflow is still going is **skipped**,
    and the skip shows in the workflow's recent fires.
  - An agent's schedule trigger set to **one at a time** skips a time that comes while its Job
    is still going, and the skip shows in the trigger's recent fires; set to parallel, every
    time starts a Job. (Firings from data events, when they exist, will wait instead of being
    skipped: an event must be handled.)
  - A Job runs the agent and the trigger **as they were when it was created**: editing either
    changes the next Job, never one already created.
  - An agent can't be deleted while one of its Jobs is still going. A conversation started from
    a chat trigger stays open until it is stopped.
  - A run or a Job still going can be **stopped** from its page: its open steps fail with
    "Stopped", its questions expire and its sessions end at once, whatever they were doing. A
    stopped run is never resumed.
  - An agent's Jobs touch the workspace's data only if the agent was given a bundle: **Work on
    data** (rows of all tables, or of chosen ones) and **Change tables and fields**. Within a
    bundle a Job asks nothing; outside it, it is refused. Taking a bundle or a table back
    applies to Jobs already running. Deleting a table or a field stays the owner's.
  - A session gets the skills and tools of its agent: skills and the runner's own tools on a
    CLI session, tools reached by URL on a cloud session and on a Job's CLI session (skills on
    cloud sessions come later). A call of such a tool asks first, and on a CLI session an
    approval allows exactly the call that was shown, once. An agent whose harness bypasses
    permissions asks nothing, so it can only use the actions that run without asking.
  - Each action of a tool reached by URL that an agent chose either asks before use or runs
    without asking (a runner's own tools ask as their CLI does, and changing a tool's address
    makes all its actions ask again). When
    a tool is added to an agent, the actions the tool calls read-only start without asking
    and the others ask; after that only the owner changes it, action by action, on the
    agent's page (under each tool) or by answering "Always allow" to an approval of that action. An action
    that reaches outside can carry what the agent read, so it is worth keeping it asking on
    an agent that reads confidential data.
  - An agent that may configure the workspace can create or change agents, delete a table or
    a field, change which actions of an agent's tool ask before use, create, change or
    delete an agent's triggers, and add a tool by its address (without credentials: the
    owner enters those) or delete an unused one, only through a proposal: it lists the exact changes, the Inbox shows each one whole with the names of
    what it points at, and approving lets that Job make exactly those changes, once each.
    Nothing else an agent says approves anything.
  - Nothing answers a Question or an Approval for the owner: no timeout, no default. What was
    answered stays in the Inbox, with who answered and when.
  - An agent can ask for an approval in its own words before it acts; each request waits for
    its own answer, whatever the agent's permission mode.
  - A button or schedule trigger must say what the agent does (its instructions); a chat starts
    with the owner's words.
  - A Tool step cut by a restart **fails and is never called again**: the owner checks the tool
    before running it again.
  - A for-each loop over a list longer than its cap **fails before its first iteration**.
- **Data** (the owner's memory, an Airtable-like grid):
  - **What it does:** tables of typed fields (text, long text, number, checkbox, date, URL,
    single select, files) with inline editing, field management (add, rename, reorder, retype,
    delete), sort and filter, a row detail and image upload. A retype shows how many cells
    would be cleared before anything changes. Data steps in a workflow create, update and find
    rows, and what they take from upstream is added to the agents' expected outputs. Grid and
    Table widgets show a table's rows on any page and update live; pages can be added, renamed
    and deleted (Home stays fixed).
  - **What it leaves out:** charts, import and export, formulas and rollups, relations between
    tables, saved views, and files from workflows (a Data step can't set a file field; files are
    uploaded by hand). Agents never read or write tables themselves: data reaches an agent only
    as values a workflow wires into its prompt.
  - **Limits** (owner decisions, cheap to change): 20 files of 10 MiB per cell, 200 fields per
    table, a page of at most 500 rows, 20 filters and 3 sorts per query, 50 pages.
