# Load test

`pnpm bench:load` measures what one Dispand process and its PostgreSQL can carry, and which of the
two runs out first. It runs on demand only: no workflow calls it.

It starts a fresh PostgreSQL container (the image `deploy/compose.yaml` pins, with
`pg_stat_statements`) and the app's Docker image, both on the host's network and bound to
127.0.0.1. It sets up the install through the API, as people would: the owner, members by
invitation, runners with a Claude Code harness each, a chat agent per runner, schedule triggers and
poll triggers. Then it ramps streaming chats step by step, while the rest keeps going:

- **Runners** speak the runner protocol through the real runner's connection
  (`apps/runner/src/connection.ts`), with its send window and its per-session text folding. Behind
  each one, a fake CLI streams text at a model's pace (default 30 deltas a second of 10
  characters, 3,500 characters an answer, which is Claude Sonnet's measured pace).
- **Chats**: each chat's person sends a message, waits until the whole answer has reached their
  open `runs.stream`, thinks for `--think` seconds, and sends the next one.
- **People** keep the Inbox stream open (`questions.stream`), and load a page every `--read-every`
  seconds (lists of chats, runs, agents, harnesses, runners and the Inbox), on a fixed schedule
  whatever the answer times.
- **Schedules** fire every minute and **polls** call a runner tool every minute. Each firing, and
  each new item a poll finds, starts a Job on a runner.

## Running it

Docker on Linux, with host networking and cgroup v2 (the containers' CPU comes from their
`cpu.stat`). Both containers listen on 127.0.0.1 only, with fresh secrets and a fresh database
password at each run; still, run it on a machine whose other users you trust, as anything local can
reach a loopback port.

```sh
pnpm build:image          # the checkout's image, dispand/app:local; or pass --image <ref>
pnpm bench:load --chats 5,10,20,40,80
```

Measure on a quiet machine: what else runs there is in the results (`host`). To keep the harness
from competing with the app, pin them apart, for example
`taskset -c 2,3 pnpm bench:load --app-cpuset 0 --pg-cpuset 1`.

| Option | Default | |
| --- | --- | --- |
| `--image` | `dispand/app:local` | The app's image. |
| `--chats` | `5,10,20,40,80` | Streaming chats at each step. Each step adds chats to the ones already going. |
| `--users` | `20` | Signed-in people. Chats are spread over them. |
| `--runners` | `20` | Connected runners. Chats are spread over them. A runner's events are handled one at a time, so chats per runner matter. |
| `--schedules`, `--polls` | `10`, `5` | Schedule and poll triggers, each firing every minute. |
| `--rate`, `--chars`, `--turn-chars` | `30`, `10`, `3500` | The fake CLI's pace: deltas a second, characters a delta, characters an answer. |
| `--think` | `2` | Seconds between an answer and the next message. |
| `--read-every` | `10` | Seconds between a person's page loads. |
| `--warmup`, `--step` | `15`, `60` | Seconds before measuring each step, and measured. |
| `--app-cpus`, `--app-cpuset` | none | Docker's `--cpus` and `--cpuset-cpus` for the app (`0`: no limit). |
| `--pg-cpus`, `--pg-cpuset`, `--pg-memory` | `1`, none, `2g` | The same for PostgreSQL. The default is a small managed database's size. |
| `--max-p99` | `10000` | Stop the ramp after a step whose delivery p99 is above this many ms. |
| `--cpu-prof` | off | Profile the app's process (`node --cpu-prof`). The profile is written when the app stops, in the results' `app/` directory. |
| `--out` | `bench/load/results/<time>` | Where the results go. |
| `--keep` | off | Leave the containers running at the end. |

## Reading the results

Each step prints one line, and `results.json` holds every number:

- **turns/s, deltas/s**: answers finished and text deltas the fake CLIs wrote.
- **updates/s**: `message` events the chats' streams delivered. Past saturation the runner folds
  text while its last text event isn't acked, so updates/s levels off and `chars per update`
  grows, while deltas/s stays as offered.
- **deliver**: from the moment the fake CLI wrote a delta to the moment its text reached the
  chat's stream, p50, p95 and p99.
- **rpc**: every API call but streams, p50, p95 and p99; per procedure in `results.json`.
- **app cpu/elu/lag99**: the app's process, sampled each second by `probe.ts` (preloaded into it):
  CPU in cores (all its threads), event-loop utilization (1 means its JavaScript thread never
  waited), and timer lateness p99 in ms (the p95 of the step's per-second values).
- **pg cpu**: PostgreSQL's container, in cores. **pg active**: the app's connections running a
  statement, of the pool's 10. `results.json` also has the wait events and the statements that
  took the most time in the step.
- **backlog**: events the runners made that the app hasn't acked yet, at most over the step.
- **harness elu**: the harness's own event loop. Near 1, the harness, not the app, limits the step:
  discard it.

The knee is the step where delivery latency starts to climb. Which resource reached its limit
there says what limits the install:

- the app's event loop near 1, with timers late: the Node process;
- PostgreSQL's CPU at its `--pg-cpus`: the database;
- neither, with every pool connection active (or waiting on `IO:WalSync`): the connection pool or
  the disk's flush time.

`pnpm bench:load:profile <file.cpuprofile>` lists where a `--cpu-prof` run's CPU went: self time
by package and by function, and total time by function. Profile in a run held at the knee (one
step), not during a ramp: the profile covers the whole process, startup included.

## Limits

- One app process: live updates reach only the streams opened on the process that made the change.
- The install allows one workspace: every person is in it.
- The production build throttles sign-in by client address. Each person sends their own
  `X-Real-IP`, taken from 198.18.0.0/15, the range set aside for benchmarks.
