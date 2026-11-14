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
  layout or the Agent Plugins standard's, whose Dispand extension also defines tables, agents
  and triggers a workspace can be set up from. The **Assistant**, a
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
    triggers, consult entries, rights and memory go with it. An agent or a tool a plugin brought stays the plugin's: it is listed as
    `<plugin>/<name>`, and it goes only with its plugin. Changing one of its fields (its name, its
    instructions, its tools, a tool's address) is yours to do: that field is then marked as yours,
    an update of the plugin replaces only what you haven't changed. When it would give an agent
    more (a tool, a table, a right), move a tool's address, reword what an agent is told, or
    meets something you changed yourself, Update first shows what it changes: your own values
    stay unless you take the plugin's, and nothing is applied until you confirm. What a new
    version adds (a table, an agent, a trigger, a tool) is named there too; the update makes none
    of it. Set up opens afterwards with them: it shows what each would be allowed to do, asks a
    harness for a new agent, and makes the ones you pick. "Reset to the plugin's"
    takes a field back. Its harness, its model, a tool's headers and sign-in are your settings and
    no update touches them. A plugin's skills work the same way, file by file (Settings, Skills,
    Files): a file you edit, add or remove is yours and stays so through updates, the others
    follow the plugin, and Reset takes one back. Removing a plugin removes what it brought. You are asked, on one
    screen and before anything is done, only about what is in use: something you changed, a table
    with rows or memory, an agent with a Job going, or anything of yours that uses it. For each
    you choose "Keep as yours" (it becomes your own, with everything that points at it) or
    "Delete" (what used it loses it); what a kept element needs is listed with it and kept too
    unless you say otherwise. An agent, a tool or a table a workflow uses can only be kept, and so can a table
    whose rows a field of one of your tables names, until that field is deleted. Deleting an
    agent stops its active Jobs and keeps their history. Native installations start selected. A conversation started from a chat trigger stays open
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
    approval allows exactly the call that was shown, once. Managed tools keep these permissions
    even when the harness bypasses native command and file approvals.
  - Each tool's action has a workspace-wide enable checkbox on the tool's settings page.
    Disabled actions disappear from agents' permission lists and cannot run in Jobs, workflows,
    or polls. Enabling one restores each agent's saved Run/Ask/Off choice. Running CLI sessions
    need a new session to regain an action they lost. Newly discovered actions start enabled
    and Ask for existing agents.
  - Each action of a tool that an agent chose is **Run**, **Ask**, or **Off**. Its checkbox
    enables or disables it; when enabled, its Ask before use switch chooses Ask or Run. Enabling
    an Off action starts with Ask. Off actions are unavailable and cannot be called. An unrelated
    edit to the agent keeps these permissions. On a running CLI session, disabling applies at
    once; re-enabling applies in a new session
    (runner tools use these permissions in Job sessions too, and changing a tool's address makes all its enabled actions ask again). When
    a tool is added to an agent, the actions the tool calls read-only start without asking
    and the others ask (for a tool from the catalog, the actions its entry lets run start without
    asking, and every other one asks, whatever the tool says); after that only the owner changes it, action by action, on the
    agent's page (under each tool) or through the memory choices on an approval of that action.
    A tool approval offers Just this call, Remember this for this run only, and, for a chosen
    tool in a Job, Remember this for this and all future runs. A run-only choice leaves the
    agent's settings unchanged; a future-run Allow sets Run and a future-run Deny sets Off.
    Workflow sessions offer run-only memory. The agent page also lists saved native CLI rules,
    showing the CLI, Allow/Deny decision and rule. Each can be removed there; removal takes
    effect when the agent starts its next session. An action
    that reaches outside can carry what the agent read, so it is worth keeping it asking on
    an agent that reads confidential data.
  - An agent that may configure the workspace can create or change agents, delete a table or
    a field, change which actions of an agent's tool ask before use, create, change or
    delete an agent's triggers, and add a tool from the catalog or by its address (without
    credentials: the owner enters those, or signs in, on the tool's page, which the agent
    links to; until then nothing calls the tool) or delete an unused one, only through a proposal: it lists the exact changes, the Inbox (and the chat it was asked in) shows each one whole with the names of
    what it points at, and approving lets that Job make exactly those changes, once each.
    Agent setup lists each tool's actions that run without asking; every other action asks.
    That list is saved with the approval, so changing a tool's defaults later does not change
    the grant. Plugin setup shows the same lists and asks for the updated review if they change
    before setup runs.
    A proposal may also list the tables and fields to create, so a whole setup is shown and
    approved at once (up to 60 changes), a later change naming what an earlier one creates
    ("the table item 1 creates"); once approved, the agent has Dispand make them in order, and
    a change refused on the way stops the rest, with what was made kept. A proposal may name
    the business it sets up: what it creates is then listed in the workspace's plugin
    "Generated: <business name>" (Settings, Plugins, Installed), which later proposals of that
    business add to. That plugin only lists: removing it keeps everything it lists.
    A plugin's table definitions are set up from its row (Settings, Plugins, Installed, Set up):
    the owner ticks them, reads the same changes a proposal would list, and makes them. A setup
    that stops keeps what it made, and the next one goes on from there: it reuses the tables and
    fields that plugin made before, even renamed, and never takes another table for one by its name.
    What it makes is the plugin's, listed as `<plugin>/<name>`: a table of yours with the same
    name stays apart, and neither goes without its plugin (a table kept when the plugin is
    removed becomes yours). Its agents are set up the same way, each on a harness the owner
    picks: a change you make to one is yours, kept through the plugin's updates. The triggers a
    plugin suggests are offered with their agent, ticked: a table-change trigger, a schedule, or
    a poll of a tool. One that can't be made yet (its tool hasn't signed in, its agent isn't set
    up) is listed with the reason and offered again later. A plugin's trigger is turned on or off
    like any other; what you change of it is yours. A server of the plugin, or a
    catalog entry, that an agent names and isn't a tool yet is added first, with no credentials:
    the owner enters them, or signs in, on the tool's page. A skill it names that isn't installed,
    or a server that runs on a machine or needs a setting, is listed, and the agent is made without it.
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
    message; "New conversation" starts another, and the page's address reopens one. The chat fills
    the page beside the sidebar. "Assistant settings" changes its harness and model for new
    conversations and Jobs; existing conversations keep theirs. Leaving the model empty uses
    the harness default, and picking another harness clears the model override.
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
  refusals included (with the tool, the table, and why it was refused); every action of an
  agent's tools a Job called, and how it ended; and every poll, with how many new items it found; and every change of a row of a primitive table, by a person or a Job, with the table, the operation and how many fields changed, when it was made (the Jobs it starts name the same event). Agents with `configure`
  read it too (`audit_list`), except rows about tables outside theirs. A row names what was touched (ids, names, counts and
  kinds), never what an agent read or wrote, and carries the trace it was recorded in: with
  `DISPAND_TRACE_URL` set, the trace id links to the tracing tool. Workflow runs have no rows.
  Rows are kept 90 days by default; the owner sets it from 1 to 3,650 days at the top of the
  Audit page ("Keep Audit for N days"), and older rows are deleted each hour. Agents can't read
  or change it, not even through a proposal: shortening it would erase the trail of what they
  did. Events and memory are not subject to it.
- **Memory:** workspace entries are on the Memory page; each table and agent has its own
  Memory tab. Entries can be added, edited, removed and restored. An agent's entry can be
  reverted; one written without `configure` is marked "Not read by agents that configure"
  until accepted. Accepting lets those agents read it too.
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

An agent’s runner-tool action permissions appear with its other tool permissions. Approved reads and drafts run without repeated questions; actions that require approval still ask. Taking a permission back also restricts sessions already running.

The Assistant uses a compact chat header, a conversation-history drawer and a centered welcome composer that moves below the messages once the conversation starts. Its composer opens the harness/model picker; weekly review lives under Assistant options. Full page expands the chat over the application navigation, and the restore button or Escape returns to the normal layout.

The Assistant model picker groups searchable cloud-provider models by harness. CLI harnesses offer their default and a model-alias field; unlisted cloud model IDs can also be entered. The composer floats over the scrolling conversation using assistant-ui’s viewport footer.

Model selection uses the same grouped harness-and-model picker in the Assistant and agent editor. Cloud catalogs come from the provider API; CLI catalogs come from the connected runner’s Codex app-server or Claude SDK, without sending a user prompt. CLI harness settings also discover models before saving. Defaults and custom IDs remain available when discovery fails. Runners must be updated for protocol 25.


In the Assistant, type `/` to find commands and skills from its harness, supplemented with
skills installed in Dispand. Search by name or description, use arrows and Enter/Tab to select,
or click an entry. Add arguments and send when ready; Escape closes the picker. Dispand-only
skills load for that conversation without changing the Assistant's permanent settings. Their
required tools retain normal approvals. Wait for a running turn to finish before adding a new
skill package. Harness discovery failures are shown explicitly; Codex currently exposes its
skills through this integration, but not its built-in command menu. Built-in Claude commands
retain Dispand's existing execution restrictions.
