# The security model

[`SECURITY.md`](../../SECURITY.md) holds the policy: how to report a vulnerability, the short list
of invariants with the tests that enforce them, who Dispand defends against and which versions are
supported. This folder holds the whole model, one file per trust boundary: what Dispand must never
do there, and what keeps it so. A change to the security model updates `SECURITY.md` or this folder,
and a change that weakens it is a vulnerability.

| Boundary | File |
|---|---|
| The browser and the network, to the app: authorization gates, input, pages, agent text, artifacts, downloads, first-run setup, the reverse proxy | [browser.md](browser.md) |
| People, to each other's workspaces and data: membership, invitations, roles, personal data | [workspaces.md](workspaces.md) |
| Agents, to Dispand's data, rights and people: platform tools, approvals, consults, questions, memory, tool permissions, Job tokens | [agents.md](agents.md) |
| The server, to tool servers, model providers and push services | [services.md](services.md) |
| The server, to its database, logs and telemetry: secrets and what leaves the process | [secrets-and-telemetry.md](secrets-and-telemetry.md) |
| The server and a runner: pairing, what the runner accepts, attachments, updates | [runner.md](runner.md) |
| Plugin and skill authors, to the server and runners | [plugins.md](plugins.md) |
| A session, to the machine it runs on: the file boundary, the container sandbox, egress, subscriptions, CLI permissions | [sessions.md](sessions.md) |
