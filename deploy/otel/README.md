# Telemetry example

Dispand sends traces, metrics and logs over OTLP/HTTP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set
(see [../README.md](../README.md)). This folder is a small stack that receives them, added to the
reference Compose project:

| File | What it is |
| --- | --- |
| `compose.yaml` | The services below, and the app's endpoint set to the collector. |
| `collector.yaml` | The OpenTelemetry Collector: metrics to Prometheus, traces to Tempo, logs to its own output. |
| `prometheus.yml`, `alerts.yml` | Prometheus scrapes the collector and evaluates the alerts. |
| `tempo.yaml` | Grafana Tempo keeps the traces. |
| `grafana/` | Grafana with Prometheus and Tempo as data sources, and the Dispand dashboard. Prometheus and Tempo publish no port: Grafana is the one page. |

## Run it

Add a Grafana password to the `.env` next to `../compose.yaml`
(`DISPAND_GRAFANA_PASSWORD=` followed by `openssl rand -base64 24`), then, from `deploy/`:

```sh
docker compose -f compose.yaml -f otel/compose.yaml up -d
```

Grafana listens on the host's loopback (Docker Engine 28 or later keeps it there; an earlier one
lets the host's network reach its sign-in page too). Reach it over an SSH tunnel
(`ssh -L 3001:localhost:3001 <host>`), at `http://localhost:3001`, and sign in as `admin` with
that password:

- Dashboards: Dispand.
- Alerting > Alert rules: the alerts below and their state, from Prometheus. Prometheus sends them
  nowhere until you add your Alertmanager to `prometheus.yml`.
- Explore, with the Tempo data source: the traces. Paste a trace id the Audit page shows to open
  it; with a tracing tool reached at a URL of its own, `DISPAND_TRACE_URL` makes those ids links.

To use a backend of your own, set `OTEL_EXPORTER_OTLP_ENDPOINT` to it instead and take the files
you need. The alerts and the dashboard use Prometheus's usual names, as its own OTLP receiver and
the collector's Prometheus exporter give them: dots become underscores, a counter ends in
`_total` and a duration in `_milliseconds` (`dispand.model.calls` is `dispand_model_calls_total`).
Every metric and its labels are listed in `packages/domain/src/telemetry/metrics.ts`.

## Alerts

Metrics carry no workspace, trigger or runner, by design: an alert says what is wrong, and the
System page of each workspace (Settings) says where.

| Alert | When | What to do |
| --- | --- | --- |
| `DispandSchedulerStale` | No scheduler tick for 10 minutes. | Schedules and polls aren't running: read the app's logs and `/api/health`. |
| `DispandRunnerOffline` | Fewer runners connected than at some point in the last hour, for 10 minutes. | The System page shows which runner is offline. The alert clears an hour after the drop, and also fires when a runner is removed on purpose. |
| `DispandRunnerOutdated` | A runner too old for the server's protocol tried to connect in the last 15 minutes. | Update it on its machine: the System page shows which one, and the Runners page the command. |
| `DispandPollFailing` | More than half the polls of a tool kind failed in the last hour. | The System page lists the poll triggers whose latest poll failed, with the error. |
| `DispandModelErrors` | More than a fifth of a provider kind's model calls failed in the last hour, out of at least 10. | Check the harness's key and the provider's status. Each retry counts as a call, and a call a person stopped counts as an error. |

## Traces

Each scheduler tick and each Job is its own trace. Spans carry ids, names, counts and kinds,
never content. Some to start from:

| Span | What it is |
| --- | --- |
| `scheduler.tick` | One pass of the scheduler, with a `scheduler.fire` per schedule or trigger it fired. |
| `scheduler.poll` | One poll of a poll trigger, and how it ended (`dispand.result`). |
| `engine.job` | A Job: every later span of the Job is its child, from its trigger to its tool calls. |
| `model.turn` | A cloud session's model call: how it ended, its tokens. |
| `tool.call` | A call of a tool's action. |
| `runner.message` | A message from a runner, and the work it started. |

## What it leaves out

- Logs stay in the collector's output, as in the app's: add a log store (Loki, for example) to
  `collector.yaml` to keep them.
- Tempo keeps 14 days of traces in its volume, Prometheus 30 days of metrics in its own.
