# Dispand

Status: Prototype

- **What it is:** an open-source, event-driven platform for running agents and automating work
  across any business domain. Users configure agents that act on business data, respond to
  events, run on schedules or handle manual requests, and stay involved by answering the
  agents' questions and approving their actions.
- **What it does today:** a web app where the owner assembles agents from harnesses (Claude
  Code and Codex CLI sessions run by the owner's own runners, or model APIs called by the
  server), skills and tools (MCP servers), gives them data tables and a memory (the
  workspace's, each table's and each agent's, in their Jobs' prompts), wires them into
  workflows that run by hand or on a schedule, and works with them from dashboards. Plugins
  bring skills, agents and tools from Git repositories and skill sites, in the Claude plugin
  layout or the Agent Plugins standard's. The **Assistant**, a
  built-in agent at the top of the sidebar, is a chat with an agent that may work on the data
  and configure the workspace.
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
  - Deleting an agent keeps its Jobs, with their transcripts, Questions and Approvals: a Job
    still going is stopped first, as from its page. Everywhere they show, those Jobs name the
    agent as "<name> (Deleted)" (the name it had when deleted), and they never run again. Its
    triggers, consult entries, rights and memory go with it. A plugin can't be uninstalled while a Job
    of one of its agents is still going. A conversation started from a chat trigger stays open
    until it is stopped.
  - A run or a Job still going can be **stopped** from its page: its open steps fail with
    "Stopped", its questions expire and its sessions end at once, whatever they were doing. A
    stopped run is never resumed.
  - An agent's Jobs touch the workspace's data only if the agent was given a bundle: **Work on
    data** (rows of all tables, or of chosen ones) and **Change tables and fields**. Within a
    bundle a Job asks nothing; outside it, it is refused. Taking a bundle or a table back
    applies to Jobs already running. Deleting a table or a field stays the owner's.
  - A session gets the skills and tools of its agent: skills on every session (a cloud session
    lists them and reads a skill's files when it needs them), the runner's own tools on a CLI
    session, tools reached by URL on a cloud session and on a Job's CLI session. A call of such a tool asks first, and on a CLI session an
    approval allows exactly the call that was shown, once. An agent whose harness bypasses
    permissions asks nothing, so it can only use the actions that run without asking.
  - Each action of a tool reached by URL that an agent chose either asks before use or runs
    without asking (a runner's own tools ask as their CLI does, and changing a tool's address
    makes all its actions ask again). When
    a tool is added to an agent, the actions the tool calls read-only start without asking
    and the others ask (for a tool from the catalog, the actions its entry lets run start without
    asking, and every other one asks, whatever the tool says); after that only the owner changes it, action by action, on the
    agent's page (under each tool) or by answering "Always allow" to an approval of that action. An action
    that reaches outside can carry what the agent read, so it is worth keeping it asking on
    an agent that reads confidential data.
  - An agent that may configure the workspace can create or change agents, delete a table or
    a field, change which actions of an agent's tool ask before use, create, change or
    delete an agent's triggers, and add a tool from the catalog or by its address (without
    credentials: the owner enters those, or signs in, on the tool's page, which the agent
    links to; until then nothing calls the tool) or delete an unused one, only through a proposal: it lists the exact changes, the Inbox (and the chat it was asked in) shows each one whole with the names of
    what it points at, and approving lets that Job make exactly those changes, once each.
    A proposal may also list the tables and fields to create, so a whole setup is shown and
    approved at once (up to 60 changes), a later change naming what an earlier one creates
    ("the table item 1 creates"); once approved, the agent has Dispand make them in order, and
    a change refused on the way stops the rest, with what was made kept. A proposal may name
    the business it sets up: what it creates is then listed in the workspace's plugin
    "Generated: <business name>" (Settings, Plugins, Installed), which later proposals of that
    business add to. That plugin only lists: removing it keeps everything it lists.
    Nothing else an agent says approves anything. In a chat, the composer then offers
    Approve (or Ctrl/⌘+Enter on an empty message); whatever you type and send instead declines
    the proposal, and the agent is told your words to make a new one.
  - In a chat, the agent's words are shown formatted (headings, lists, code, emphasis). An
    image shows only when it is a file of the workspace, and a link says where it goes and
    opens only when clicked.
  - Nothing answers a Question or an Approval for the owner: no timeout, no default. What was
    answered stays in the Inbox, with who answered and when.
  - An agent can ask for an approval in its own words before it acts; each request waits for
    its own answer, whatever the agent's permission mode.
  - The Assistant can't be deleted, nor lose its rights (working on data and changing tables, on
    every table), its platform skill or its chat, by the owner or through a proposal; its name,
    harness, model and instructions are the owner's to change. It is made when the owner picks
    its harness. Until then, Home opens the Assistant's page, a fresh install's first page,
    which adds a harness when there is none and then starts the Assistant on the one picked.
    Its conversations are listed beside the chat, newest first, each named by its first
    message; "New conversation" starts another, and the page's address reopens one.
  - The Assistant's **weekly review** is off until the owner turns it on, on the Assistant's
    page (Mondays at 09:00 in their time zone; the schedule stays editable on the Assistant's
    agent page, and the review can be turned off but not deleted). It looks for agents with no
    trigger, tables no agent works on, tools waiting for a sign-in, Questions open more than
    three days and buttons pressed at the same hour often enough to be a schedule, and asks for
    one change per finding as an Approval in the Inbox; it carries out only what is approved,
    and doesn't raise a finding again for 30 days once its change was declined. The same review
    can be asked for in the chat.
  - The **platform skill** (`dispand-platform`, in Settings › Skills, built in and read-only)
    tells an agent how Dispand works and how to propose a setup. It comes with each version of
    Dispand. The Assistant always has it; any other agent may be given it, which grants nothing.
  - A button or schedule trigger must say what the agent does (its instructions); a chat starts
    with the owner's words.
  - A Tool step cut by a restart **fails and is never called again**: the owner checks the tool
    before running it again.
  - A for-each loop over a list longer than its cap **fails before its first iteration**.
- **Audit** (sidebar, and a section of each Job's page): what the agents' work did and met,
  newest first, 50 at a time. Today a Job's life: created (who or what made it), queued for its
  harness, started (on which harness and runner, or resumed), waiting for an answer, finished or
  failed (stopped by a person, at a declined checkpoint, by a consult taken back, or failed), and
  a trigger's firing that started no Job (skipped while its Job runs, refused, out of the
  agent's reach, or a Job's own change); its Questions and Approvals asked, answered (with the
  decision and whether a person or an agent answered) or expired; a checkpoint reached and
  answered (approved, don't ask again, or declined, with how many held events and Jobs it
  stopped); a consult asked and how it ended; and every Dispand tool a Job called, reads and
  refusals included (with the tool, the table, and why it was refused). Agents with `configure`
  read it too (`audit_list`), except rows about tables outside theirs. A row names what was touched (ids, names, counts and
  kinds), never what an agent read or wrote, and carries the trace it was recorded in: with
  `DISPAND_TRACE_URL` set, the trace id links to the tracing tool. Workflow runs have no rows.
  Rows are kept 90 days by default (`workspace_settings.audit_retention_days`; nothing sweeps
  them yet).
- **Data** (the owner's memory, an Airtable-like grid):
  - **What it does:** tables of typed fields (text, long text, number, checkbox, date, URL,
    single select, files, and links to a row of another table) with inline editing; a table
    can be made primitive, so changes to its rows can start agents' Jobs, and given a parent
    table its rows belong to, field management (add, rename, reorder, retype,
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
