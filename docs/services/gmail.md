# Gmail

Dispand reaches Gmail in one of two ways, both from Settings → Tools → Browse catalog. Either
way it signs in with a Google Cloud OAuth client that you, the person running Dispand, register
in your own Google Cloud project: Dispand ships no Google client of its own. Both ask Google for
two scopes only: `gmail.readonly` (search and read) and `gmail.compose` (drafts).

| | **Gmail** (Google's hosted server) | **Gmail (on a runner)** |
| --- | --- | --- |
| Accounts | Google Workspace accounts enrolled in Google's [Workspace Developer Preview Program](https://developers.google.com/workspace/preview) | Any Google account, personal Gmail included |
| Runs | At Google (`https://gmailmcp.googleapis.com/mcp/v1`), called by the Dispand server | On a machine with a paired runner ([`@artymclabin/gmail-mcp`](https://github.com/ArtyMcLabin/Gmail-MCP-Server), MIT) |
| OAuth client | Web application, redirect URI `<app>/oauth/callback` | Desktop app |
| Sign-in kept | Sealed in Dispand's database, renewed by Dispand | On the runner's machine, in `~/.gmail-mcp/` |

What both do and don't do:

- **Actions that run without asking** (when you give the tool to an agent): search, read and
  draft. Sending, labels, trash and everything else ask you first. A runner tool asks on the
  runner for every call anyway; there, the list decides only what a poll may read.
- **The poll preset** (Agents → an agent → Triggers → Poll, then pick the tool) starts a Job for
  each new thread in the inbox. A thread is the item: a new reply in a thread a poll has already
  seen starts no Job. Gmail's `after:` takes seconds, so the preset uses `{{lastPollEpoch}}`.
- **On a runner, a poll reads at most 50 new threads.** That server lists the newest threads
  without a next page, so when more than 50 arrive between two polls (a runner left offline
  overnight, say), the older ones never start a Job: they stay in the mailbox, unread by the
  agent. The hosted server pages through every new thread, and has no such limit.

## The Google Cloud project (both ways)

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project, or pick
   one. With a Workspace account, create it inside your Workspace organization: only then can
   its consent screen be **Internal**.
2. Enable the **Gmail API** (APIs & Services → Library, or
   `gcloud services enable gmail.googleapis.com --project=<project>`). For the hosted server,
   also enable the **Gmail MCP API** (`gcloud services enable gmailmcp.googleapis.com --project=<project>`).
3. Open **Google Auth Platform** (APIs & Services → OAuth consent screen). If it says it isn't
   configured yet, click **Get Started**. Under **Branding**, give the app a name (such as
   "Dispand") and a user support email.
4. Under **Audience**, pick the user type:
   - **Internal**, for a Google Workspace account (the way we recommend there). Only members of
     your Workspace organization can sign in, and Google asks for no verification, no test
     users and no publishing: there is no "unverified app" screen and no 7-day limit on the
     sign-in. A Workspace administrator may have to allow the app first: Gmail's scopes are
     restricted, and some organizations require an administrator to trust apps that ask for
     them (Admin console → Security → Access and data control → API controls).
   - **External**, for a personal Gmail account, or a Workspace account whose project can't be
     Internal. Then:
     - In **Testing** (the starting status), add your own address under **Test users**. Google
       ends a test user's sign-in **7 days** after consent: the tool then says "re-authorize"
       (hosted) or its calls fail until you sign in again (runner).
     - To keep the sign-in, click **Publish app** (status **In production**). An app that asks
       for Gmail's restricted scopes without Google's verification shows an **"unverified app"**
       screen ("Google hasn't verified this app") before the consent screen: you go on through
       **Advanced**, then **Go to <your app> (unsafe)**. That is expected for your own app
       used by yourself: Google allows an unverified app up to 100 users in total, which covers
       personal use. Its sign-in then lasts until you revoke it, change your password, or leave
       it unused for months.
5. Under **Data Access**, click **Add or Remove Scopes**, and under **Manually add scopes** add
   `https://www.googleapis.com/auth/gmail.readonly` and
   `https://www.googleapis.com/auth/gmail.compose`, then **Update** and **Save**.

## Gmail through Google's hosted server

For a Workspace account enrolled in the Developer Preview. Google opens the server to enrolled
accounts only; any other account gets an error at its first call. Use the runner way meanwhile.

1. In **Google Auth Platform → Clients**, click **Create Client**, choose **Web application**,
   and under **Authorized redirect URIs** add your Dispand's callback: `https://<your Dispand host>/oauth/callback`
   (the `DISPAND_HOST` of `deploy/README.md`). Tick **Use this client for an AI-powered
   agent**: Google requires it for clients of its Gmail server. Create it, and copy its client
   ID and client secret.
2. In Dispand, Settings → Tools → **Browse catalog** → **Gmail** → **Install**. The tool is
   added, not connected yet: it lists nothing before you sign in.
3. On the tool's page, enter the client ID and secret, then click **Connect**. Google asks you to
   pick the account and to allow reading and drafting your mail (with an Internal app, no
   warning; with an External one, the "unverified app" screen first, as above). Back in Dispand,
   the tool says connected and lists its actions.

Dispand asks Google for the two scopes alone, though Google's server says it supports every Gmail
scope, and for offline access (`access_type=offline`, with `prompt=consent`), so Google gives a
refresh token and Dispand renews the sign-in by itself. The client secret and the tokens are
sealed in Dispand's database and are never sent to the browser, a runner or an agent.

## Gmail on a runner

For any Google account. The server runs on a machine where a Dispand runner is paired, as the
same user as the runner; its sign-in stays on that machine.

1. In **Google Auth Platform → Clients**, click **Create Client**, choose **Desktop app**, and
   create it. Download its JSON file (**Download JSON**) and save it as
   `~/.gmail-mcp/gcp-oauth.keys.json` in the runner user's home folder (create the folder, readable
   by that user only: `mkdir -m 700 ~/.gmail-mcp`).
2. Sign in once, on that machine, as that user, with the two scopes:

   ```sh
   npx -y @artymclabin/gmail-mcp@1.2.3 auth --scopes=gmail.readonly,gmail.compose
   ```

   It opens Google's sign-in in the browser (or prints its address) and waits for Google to send
   you back to `http://localhost:3000/oauth2callback` on that same machine; the address must open
   there. It saves the sign-in to `~/.gmail-mcp/credentials.json`, with the scopes, and offers
   only the actions those scopes allow (no label, filter or delete actions).
3. In Dispand, Settings → Tools → **Browse catalog** → **Gmail (on a runner)**: add the snippet it
   shows under `mcpServers` in the runner's `config.json`, restart the runner, then **Pick the
   runner** and **Add tool**.

The server's version is pinned in the snippet; the catalog moves it after checking a new one.
It was chosen over the other open-source Gmail servers because its thread listing answers in
JSON (which a poll reads), it can sign in with exactly these two scopes and offer only the
actions they allow, and it marks its read-only actions.

## Changing your mind

Revoke Dispand's access at [your Google account's connections](https://myaccount.google.com/connections).
For the hosted server, then delete the tool in Dispand; for the runner, also delete
`~/.gmail-mcp/credentials.json` on the runner's machine.
