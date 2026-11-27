# Diagrams

The stable views: what Dispand talks to, what it is made of, the states a step and its session go
through, and how a runner connects. The files beside this one hold the rules behind them.

## Context

```mermaid
flowchart LR
  people["Members, managers<br/>and the organization's owner"]
  dispand["Dispand"]
  runners["Runners<br/>on people's machines"]
  models["Model providers"]
  tools["Tool servers (MCP)"]
  push["Browser push services"]
  sources["Plugin and skill sources<br/>(git, skill sites)"]
  otlp["OTLP collector<br/>(when configured)"]

  people -- browser --> dispand
  runners -- "dial in (HTTPS, WebSocket)" --> dispand
  runners -- "the agent CLIs' model calls" --> models
  dispand -- "cloud sessions" --> models
  dispand -- "tool calls and polls" --> tools
  dispand -- notifications --> push
  dispand -- fetches --> sources
  dispand -- telemetry --> otlp
```

## Containers

The reference deployment (`deploy/compose.yaml`) is the app and PostgreSQL behind your reverse
proxy. A development or test server may use PGlite in place of PostgreSQL.

```mermaid
flowchart TB
  subgraph person["A person's device"]
    web["Web app and service worker"]
  end
  proxy["Reverse proxy (TLS)"]
  subgraph server["Server"]
    app["App (apps/web, packages/domain)<br/>pages, API, Job endpoints, files,<br/>engine, scheduler, runner hub,<br/>cloud sessions, push sender"]
    db[("PostgreSQL")]
    files[("Files volume")]
  end
  subgraph machine["A runner's machine"]
    runner["Runner (apps/runner)"]
    cli["Claude Code and Codex sessions<br/>(each in a worker in the container image)"]
    stdio["MCP servers from the runner's config<br/>and allowed plugins"]
  end

  web -- HTTPS --> proxy
  proxy -- "port 3000" --> app
  app --> db
  app --> files
  runner -- "HTTPS and WebSocket, outbound" --> proxy
  runner -- "the session's tools, over the CLI's own channel" --> cli
  runner -- "Job endpoints, over HTTPS" --> proxy
  runner --> stdio
```

In the container image the supervisor, not the worker, holds the Job endpoints' address and token
and connects to every MCP server the session gets (`docs/security/sessions.md`). On the bare install
the CLI reaches the Job endpoints itself, and starts the runner's MCP servers through the runner's proxy.

## States

A run's node is a `step_runs` row. Its status, its session's turn and, for a cloud harness, the
session itself each have their own states. `db/state-diagrams.test.ts` in `packages/domain` fails
when a diagram below names a state its type in `db/schema.ts` doesn't have, or misses one.

### Step status (`StepStatus`)

```mermaid
stateDiagram-v2
  [*] --> pending : the run, or a loop's iteration, opens it
  pending --> running : its session, Tool step, data step or loop starts
  pending --> succeeded : settled without running
  pending --> skipped : on a branch the run didn't take
  pending --> failed : it can't start, or the run is stopped
  running --> waiting : a question is pending
  waiting --> running : no question is pending
  running --> succeeded
  waiting --> succeeded
  running --> failed
  waiting --> failed
  succeeded --> running : its chat continues on the same harness
  succeeded --> pending : its chat continues in a fresh session
  failed --> running : its chat continues on the same harness
  failed --> pending : its chat continues in a fresh session, or it never started and its workflow's chat continues
  skipped --> pending : it never started and its failed workflow's chat continues
```

### Turn status (`TurnStatus`)

What an interactive session last reported of its turn, apart from the step's status and from
whether it holds a harness slot.

```mermaid
stateDiagram-v2
  [*] --> unknown : a new session
  unknown --> running : turn-start
  unknown --> idle : turn-end, or the step ends
  running --> idle : turn-end, or the step ends
  idle --> running : turn-start
  running --> unknown : the session is lost or ended
  idle --> unknown : the session is lost or ended
```

### Cloud session status (`CloudSessionStatus`)

Dispand runs a cloud session's tool loop itself (`cloud/runner.ts`).

```mermaid
stateDiagram-v2
  [*] --> running : started with a prompt
  [*] --> idle : a chat started with none
  idle --> running : a message, or a resume
  running --> waiting : it asks a question
  waiting --> running : the answer, a resume, or an interrupt with a message queued
  running --> idle : a chat's turn ends, or is interrupted
  waiting --> idle : interrupted
  running --> done : its result, its outputs, an error or a stop
  waiting --> done : its outputs are confirmed, or a stop
  idle --> done : a stop
```

## A runner's connection

```mermaid
sequenceDiagram
  participant R as Runner
  participant H as Runner hub
  participant E as Engine

  Note over R,H: Once, to pair
  R->>H: POST /runner/pair (single-use pairing code)
  H-->>R: runner token

  loop until the upgrade is accepted
    R->>H: GET /runner/ws (token, Dispand-Protocol)
    alt refused
      H-->>R: 401, 426, 400 or 503
      Note over R: waits a random time, longer each time (not after a 503), then dials again
    else accepted
      H-->>R: 101, the WebSocket
    end
  end

  R->>H: hello (lastSeq, live sessions, CLIs, tools)
  loop events not acknowledged yet, oldest first
    R->>H: event (seq)
    H->>E: handle it (a seq already handled is only acknowledged)
    H-->>R: ack (seq)
  end
  Note over H: events up to hello's lastSeq are handled, so the connection is ready
  H->>E: caught up (live sessions)
  E->>R: what didn't arrive (starts, messages, answers), and stops for sessions no step waits on

  loop while connected
    E->>R: session.start, session.send, session.answer, session.interrupt, session.stop
    R->>H: event (seq)
    H-->>R: ack (seq)
    R->>H: WebSocket ping
    H-->>R: pong
  end
  Note over R: nothing read since the last ping, so it ends the connection and dials again
```

The upgrade is refused with 401 for an unknown or revoked token, 426 for a runner older than the
server, 400 for any other protocol version, and 503 while the server takes no connection for that
runner.
