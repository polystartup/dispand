# The server, to tool servers, model providers and push services

- **An agent's tool reached by URL is called on the server, and on a runner only after the
  owner approved that exact call.** A Job's CLI session gets these tools from a second
  endpoint, `/mcp/job/tools` (same Job token, address built by the runner like the Job
  endpoint's, under the reserved name `job_tools`); it sees each action's name, description and
  schema, never the tool's headers or full address (a failed call may name the tool's host). The CLI asks the owner before each call, like
  for any MCP tool, and that question and its answer are recorded on the server. The endpoint
  runs a call only when it finds, in its own records, an approval of that Job for that tool and
  those arguments (key order aside), answered with an allowance and not used yet, and uses it
  up: it never takes the runner's word that the owner said yes, an approval allows one call,
  and "always allow" is no approval of later calls: it is the owner taking that action off
  the agent's asking ones ([agents.md](agents.md)), and the answer itself is used up as it is given. The name a tool is asked and called under
  is derived from the tool's id and the action's name alone, so an approval can't move to
  another tool or action; a tool's schema is passed on as data and never compiled. That name
  is words cut short and a mark, so the question the owner answers also carries, from the
  server, the tool's name and the action's name and description in full. Managed actions ask in
  `bypassPermissions` mode too, unless the agent already has permission to run them without asking. Every call a Job makes of such a tool, in a
  cloud session or through `/mcp/job/tools` (a call refused for want of an approval included),
  and every poll leave one Audit row (`tool.call`, `poll.run`) written after the call: the tool,
  the action and how it ended, and for a poll its status and how many new items it recorded;
  never the arguments, the result, an item or its id, and a failure to write the row never
  changes what the call returns.
- **An OAuth tool's tokens, client secret and code verifier never leave the server.** They are
  sealed per tool, keyed by authorization server, and go only where the MCP SDK's flow sends
  them: the access token to the tool's URL, the rest to its authorization server's token
  endpoint. Not to the browser (views say connected, needs authorization or re-authorize, and
  the entered client id), a runner, an agent, a log or telemetry. Every request of the flow
  (metadata, registration, token, refresh) goes through the connector's guarded fetch: the
  address guard, https only (but to this machine), no redirect to another origin, and the
  connection's 16 MiB budget; a token endpoint's refusal, whatever its status, keeps only its
  error code before the SDK reads (and logs) it. An OAuth tool sends no static header and is
  reached only over https (or on this machine), and what it sends back is redacted of its
  tokens and client secrets. Any member connects a tool, but only a manager enters, changes or
  removes its client id and secret, since that erases the tokens the whole workspace uses
  (`tools.authorize` with `client`). An entered client id and secret are bound to the authorization
  server they were first used with: another one the server names later never gets them. A flow
  or refresh still under way when the tool is pointed elsewhere saves nothing and connects
  nothing. Only
  the owner's session finishes a flow it started, with the `state` it sealed, once and within
  10 minutes. A tool whose refresh is refused is marked "re-authorize": its calls fail before
  any request until the owner signs in again; a call never starts a flow. The client metadata
  document (`/oauth/metadata`) is public on purpose: it holds the app's name and callback only.
- **A Web Push carries an agent's name, the item's kind and its random id, nothing else.** What
  agents wait on reaches the browsers the owner allowed (`push_subscriptions`, from the Inbox) through
  the browser vendor's push service: the payload is exactly `{ text, count, itemId }`, `text` a
  sentence naming the agent and the kind ("Drafting needs your decision."), `itemId` the newest
  item's opaque id, never a question's text, an answer or a proposal's items. We decided an agent's
  name, which the owner may make business-specific, may pass through that service. The payload is
  encrypted to the browser's keys (RFC 8291) and signed with the install's VAPID key, generated
  once and sealed like the other secrets; a subscription's keys are sealed too, and `push.list`
  returns neither them nor its endpoint. The server posts only to an `https://` endpoint the
  signed-in owner subscribed, in production never to its own addresses (the tools' guarded
  fetch), reads only the answer's status and gives up after 15 seconds. Signing out deletes that browser's subscription (`push.unsubscribe` needs only a session, never a workspace, and deletes only the person's own rows), and one the push
  service answers 404 or 410 for is deleted. The page's only worker is its own service worker
  (`worker-src 'self'`, `/sw.js`), which shows every push and opens `/inbox?item=<id>` on a
  click. The push procedures are no tool.
- A cloud harness's key is sent only to its base URL, which must be `https://` when a key is
  set (plain http only to loopback); listing its models follows no redirect, and a provider's
  error reaches the owner as a short reason, never its body.
  A harness's runner and base URL are its workspace managers' to set, whoever made it: every
  agent and workflow of the workspace that uses the harness sends its prompts and inputs there,
  the workflows of other members included. The base URL may be loopback or on the deployment's
  own network (a local model server is a supported provider), and model listing and model calls
  go there from the server. **Out of scope:** a manager reaching the server's network through a
  harness's base URL; a deployment that hosts people it doesn't trust with that blocks those
  addresses at its egress.
  A cloud session opens the key at each model call and holds it only for that call: no
  `cloud_sessions` row, event, step error or log carries it, and a failed call ends the step
  with a short reason (refused key, rate limit, status code, unreachable host), never the
  provider's body, once a transient failure has been retried within bounds (`retryDelay`). A cloud agent's tool calls (other than `ask_user` and `submit_outputs`, which
  Dispand answers itself) each need the owner's approval, shown whole, but for the actions the
  agent lets run unasked ([agents.md](agents.md)). The owner may remember a decision for the run or, when offered,
  for the agent's future runs. The engine stores it from the server-resolved tool key; no cloud
  caller writes permanent permissions independently. The obsolete session allowance column is
  removed; current permission policy is read at every call.
  A tool's headers go only to its URL, which must be `https://` when it has headers (plain
  http only to loopback) and can't carry credentials itself. They are for the server they
  were entered for: changing a tool's origin (scheme, host, port) or its transport drops
  every saved header, and only those given with that change are kept, so the owner enters
  them again for the new address. The cryptography holds it too: a header's AAD also names
  the origin of its tool's URL (`headerAad`), so a header left on a tool pointed at another
  origin doesn't open and is never sent there. Headers sealed before this binding are sealed
  again once, at server start, with the origin their tool calls then (`tools/reseal.ts`); MCP calls follow a redirect only
  within the tool's origin, and a failure reaches the owner as a short reason made by
  Dispand (host, status), never the server's answer. Whatever the server sends back (action
  names and descriptions, results) has the header values, and each word of them but a scheme
  name, replaced by "••••" before it is stored or shown. **Out of scope:** a server that sends
  them back transformed (encoded, split, reversed): it already holds them, and only the owner
  sees what it returns. A catalog entry that runs on the owner's machine (a runner entry) never
  takes a key in Dispand: the snippet it shows has placeholders, and the key stays in the
  runner's config. Dispand calls the URLs the owner
  enters (a tool acts as whatever account its headers authorize), except, in production, its own
  addresses: loopback, link-local and the subnets of the app's network interfaces (the Compose
  network with PostgreSQL), checked on the address each connection is made to.
  Tool steps call a tool from the server, with its headers, through the same connector and
  rules: an agent never gets a Tool step's tool or its headers, only the outputs a prompt or
  input wires to it. A Tool step runs only the HTTP tools of its run's workspace (looked up by id and
  workspace at each call), and a call cut by a restart is never made again: its step fails.
  An operator with the database and the key can read them (see [`SECURITY.md`](../../SECURITY.md)).
