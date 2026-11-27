# Who can attack, and what they reach

What each party can reach today, and what Dispand does about it. The rules behind each answer
are in the boundary files beside this one. A reviewer judges a finding by whether its attacker is
here, and by whether it takes that party further than this page says.

## Anyone who can reach the app, not signed in

**Reaches:** the pages and static files (the runner's installer among them), sign-in, the procedures that need no session (first-run setup and its
status, a new account's preview and sign-up through an invitation), runner pairing
(`POST /runner/pair`), the OAuth callback and client metadata, and the health check.

**What Dispand does:** every other procedure and endpoint asks for a session, a runner's token or a
Job's token. Setup needs the server's setup code, and wrong codes and wrong sign-ins are throttled
per `X-Real-IP`. A pairing code and an invitation token are single-use or replaced on reissue, and
expire. [browser.md](browser.md), [runner.md](runner.md), [workspaces.md](workspaces.md).

## A signed-in person outside the workspace

Someone with an account who isn't a member of the workspace or its organization, a removed member
included.

**Reaches:** their own session and profile, unsubscribing their own browser from pushes, and the
invitations made out to them.

**What Dispand does:** the role is read at each request and before each later event of a stream: a
request into a workspace or organization they aren't in is refused as not found, a stream open when
they were removed gets nothing more, and an organization's refusal tells them nothing.
[workspaces.md](workspaces.md).

## A member of a workspace

**Reaches, in that workspace:**

- every table, row and table file, and the workspace's memory, to read and write. A Job's other
  files are narrower: one attached to a committed chat message is read by whoever reads that
  transcript, a raw tool result or a held upload only by its owner;
- every agent but other people's Assistants: its instructions, tools, tables, bundles, who it
  consults and asks, which tool actions run without asking and its saved command rules; every skill package, trigger and
  workflow, to change and start;
- every agent Job's transcript but another person's Assistant chats (a workflow run stays its
  starter's);
- every tool's credentials in use, never to read: a workflow's Tool step calls an action with no
  Approval, and a member may set an agent's action to run unasked. A member also turns a tool's
  actions on or off for the whole workspace, chooses what polls may read, and connects a tool by
  OAuth, which shares that account with everyone in it;
- the machine of a runner the workspace has, through its agents: the permission questions of a Job a
  member started go to that member, and answering one asks for no role. An approved command runs as
  the runner machine's user on the bare install, and inside the session's worker in the container
  runner. Where a manager set a harness to bypass permissions and the runner allows it, commands run
  with no question;
- other people's Jobs, a manager's included, by changing an agent, a skill, a workflow, a table or a
  memory entry they later run on. A Job acts with the rights of the person it acts for, so one a
  manager starts passes the manager's procedures a Job may call (reading the Audit, with
  `configure`), and what it reads goes in a transcript members read.

**Out of reach:** creating, changing or deleting harnesses; adding, changing or deleting tools;
registering, renaming, revoking or updating runners; plugins, marketplaces and native plugin grants;
the workspace's settings, its Audit and its memberships; another person's Assistant, pages and
Inbox; any stored secret's value; other workspaces.

**What Dispand does:** the role is read at each request, and an agent changes what agents may do
only through an item a person approved. A member is trusted with what the list above reaches: a runner paired to a workspace, and a credential added to it, serve
all of its members. [workspaces.md](workspaces.md), [agents.md](agents.md),
[sessions.md](sessions.md).

## A manager of a workspace

**Reaches:** everything a member does, and:

- harnesses: their runner, base URL, key and permission mode. Every session of every agent that uses
  a harness, other people's Assistants included, sends its prompts and inputs to that endpoint or
  machine. A cloud harness's base URL may be loopback or on the deployment's own network, and the
  server lists models and calls them there: a deployment that hosts people it doesn't trust with
  that blocks those addresses at its egress;
- tools: their address, transport and headers; runners: registering one, whose machine then receives
  the sessions of the agents set on it; plugins, marketplaces and native plugin grants, which bring
  instructions and, on runners that allow it, code;
- the workspace's settings, its Audit and who is in it.

**Out of reach:** another person's Assistant, pages and Inbox through the app (but see the harness
above); a stored secret's value; the organization's files limit and data retention.

**What Dispand does:** a manager is trusted with the workspace. A tool pointed at another origin
loses its saved headers, a runner's own config bounds what the server may make it run, and a
runner runs a plugin's code only on its own record or, in the container runner, in a worker.
[services.md](services.md), [runner.md](runner.md), [plugins.md](plugins.md).

## The organization's owner

**Reaches:** every workspace of the organization as its manager, its files limit and data
retention, and invitations that let a new account set a password. Not another person's Assistant
chats through the app.

## Authors of what agents read

Whoever sends a mail a poll reads, writes a page or a record a tool returns, writes a table's row,
publishes a plugin or a skill, or runs an agent that writes memory or answers a consult.

**Reaches the model:**

- a polled item, whole (up to 256 KiB), in its Job's prompt;
- the values before and after a table change, in the prompt of the Job its trigger starts;
- tool results, tool and action descriptions, and rows an agent reads;
- a plugin's agent instructions as a system prompt, and its skills' files as skills;
- memory entries in the system prompt, consult questions and answers, and in workflows the outputs
  of earlier steps.

Where Dispand writes such text into a prompt itself (a polled item, a row's values, a Tool step's
result, another agent's answer), it goes in a data block a model is told not to take instructions
from ([agents.md](agents.md)). That binds no model, and Dispand filters none of it for
instructions: **assume its author can steer any Job that reads it.**

**A steered Job can, with no question asked,** within what its agent was given (the built-in
Assistant holds `data` and `configure`):

- with `data`, read, write and delete the rows of its tables; with `configure`, create tables and
  change their fields, and, on every table, read other Jobs' transcripts;
- write memory where its agent's self-learning allows;
- call the tool actions its agent lets run unasked, which by default are those the server declares
  read-only, or the catalog's list, and carry what it read in their arguments;
- consult the agents it may consult, ask a person it may ask, and show an artifact;
- on a runner, read in its session folder, write there where the harness's permission mode lets
  edits through, and run a command a saved allow rule matches; a Codex session also runs the
  commands Codex knows as read-only, and reads beyond its folder: on the bare install, whatever the
  runner's user can read (SSH keys included) but the runner's config and the CLIs' config and
  credentials, and in the container runner only what its worker mounts. Under bypass permissions,
  which the runner's config must allow, a session runs any command and Codex has no sandbox, so
  those exceptions are gone too. A restricted Job is outside this and gets no shell, whatever the
  harness ([agents.md](agents.md));
- in a workflow, give its outputs to a Tool step, which calls its action with no Approval, or to a
  data step that writes rows.

**It needs a person for:** every other tool action and shell command, any change of an agent, a
trigger or a tool (but turning off its own agent's trigger), and a deletion of a table, a field or
an agent. A runner's CLI keeps its machine user's own settings, which can allow or enable more of
its built-in tools (a web fetch or search, say).

**What Dispand does:** it holds those limits, read at each call; the question shows the person the call
whole; an agent's text loads nothing in the browser, and an artifact runs only on a click; a poll
reads no action its agent must ask for; memory written without `configure` stays out of a
configuring Job's prompt until a member accepts it; a plugin's install and update show what they
change. [agents.md](agents.md), [plugins.md](plugins.md), [sessions.md](sessions.md).

## The services Dispand calls

- **A tool server** sees the arguments and headers sent to it, and writes its actions' names,
  descriptions and results (an author above). Its headers go only to its origin, what it returns is
  bounded and redacted of them, and its errors reach people as short reasons.
- **A model provider** sees every prompt, tool result and attachment of the sessions sent to it.
- **A push service** carries each notification, encrypted to the browser: a sentence naming the
  agent or workflow and the item's kind, a count and an item's random id.
- **A plugin, marketplace or skill source** serves files, fetched over https within bounds; a plugin's
  code runs only as [plugins.md](plugins.md) says.

## A paired runner

A runner is trusted with what its sessions are given (prompts, files, skills, memory, Job tokens)
and with the work done on its machine: a hostile one misuses all of that, and its manager revokes
it. The limits on its frames contain its mistakes, not a hostile one, which can for instance fill
its sessions' transcripts without end.

**Out of reach, and kept by the server without trusting it:** anything neither its token nor its
sessions give it. Its token alone, whether or not a session runs, fetches only the files of what is
placed on it: skills, plugins and chat attachments ([plugins.md](plugins.md) and
[runner.md](runner.md) say which). Its events reach only the sessions the server started on it, a
Job token gives only that Job's rights, and a tool the server calls runs only on an approval the
server recorded or an action the agent lets run unasked ([agents.md](agents.md)).

## Not defended against

An operator with access to the host, its database or the server's environment.
