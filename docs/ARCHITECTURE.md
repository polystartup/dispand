# Architecture of dispand

How Dispand is built, in parts:

- [Packages, the API, runners and harnesses](architecture/runners-and-harnesses.md): Apps and packages, API, Runners, Native skill selection (protocol 16), Harnesses, Cloud sessions.
- [Workflows, the engine and Jobs](architecture/engine.md): Workflows and the engine, Schedules, Jobs and triggers, Checkpoints, Harness slots.
- [Telemetry and Audit](architecture/telemetry-and-audit.md): Telemetry, Audit.
- [Platform tools, the Assistant, memory and the Inbox](architecture/assistant-and-inbox.md): Platform tools, The Assistant, The enhancement review, The platform skill, Skills and tools in sessions, Memory, Skills in cloud sessions, What polls may read, Proposals, Inbox, Push notifications, Stopping a run, Home and widgets.
- [The runner](architecture/runner.md): The runner, A plugin's stdio server on a runner (runner side), A plugin's stdio server on a runner (server side), Runner distribution.
- [Data, attachments and chat messages](architecture/data.md): Data, Tables (Data), Rows (Data), Data screens, Attachments (Data), Chat attachments, Steering (protocol 33), One row per assistant message (protocol 41), Secrets at rest.
- [Tools, skills and plugins](architecture/tools-skills-plugins.md): Tools (MCP servers), Skills, Plugins, Skill sources.
- [Authentication, gates, the server and deployment](architecture/auth-and-deployment.md): Authentication and authorization, Organization gate, Place gate, Web server settings, Class names, Build and migrations, Package, Design, Production entry, App startup, Health, Upgrades, Deployment, Decisions.
- [Tool permissions and plugin updates](architecture/permissions-and-plugin-updates.md)
- [Chats, the slash picker and languages](architecture/chats-and-languages.md): Continuing an ended chat, Queued chat messages, Assistant slash picker, English and French.

What must never happen, and what keeps it so, per trust boundary: [the security model](security/README.md).
