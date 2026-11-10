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
  - An agent can't be deleted while one of its Jobs is still going. **Known limit:** a run can't
    be stopped by hand yet, and a conversation started from a chat trigger stays open, so an
    agent that has had one can't be deleted (as a workflow whose chat run never finished can't
    be). Stopping a run or a Job is the next change planned here.
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
