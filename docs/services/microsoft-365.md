# Microsoft 365 mail

Dispand reaches Outlook mail (Microsoft 365 work or school accounts, and personal Outlook.com
accounts) through [`@softeria/ms-365-mcp-server`](https://github.com/Softeria/ms-365-mcp-server)
(MIT), a Microsoft Graph server run on a machine where a Dispand runner is paired. Microsoft's
own hosted mail server is in preview; the catalog will offer it once it isn't.

The catalog entry starts the server with its mail actions only (`--enabled-tools`): listing and
searching messages, reading one, its text and its attachments, and drafting a reply. The server
asks Microsoft, at sign-in, for the permissions of the actions it offers, so connecting it grants
mail (`Mail.Read`, `Mail.ReadWrite` for drafts) and never calendar, files or Teams. It has no
action that sends: a reply stays a draft in your mailbox until you send it.

- **Actions that run without asking** (when you give the tool to an agent): listing, reading and
  reply drafts. Saving an attachment's content and the server's own account actions (`login`,
  `logout`, accounts) ask. A runner tool asks on the runner for every call anyway; there, the
  list decides only what a poll may read.
- **The poll preset** (Agents → an agent → Triggers → Poll, then pick the tool) reads the inbox
  folder only (so the agent's own drafts and sent replies never start Jobs), newer than
  `{{lastPoll}}`, oldest first, 25 messages a page, and follows Graph's next link page by page
  until the end, ties included. Each new message starts a Job.

## Sign in (on the runner's machine)

There is nothing to register in Azure: the server signs in with its own Microsoft app, through
Microsoft's device code. Sign in as the same user the runner runs as, with the same command the
runner will use, so the server finds the sign-in again:

```sh
npx -y @softeria/ms-365-mcp-server@0.175.0 --login --enabled-tools '^(list-mail-folder-messages|list-mail-messages|get-mail-message|read-mail-text|list-mail-attachments|get-mail-attachment-content|create-reply-draft)$'
```

It prints a code and Microsoft's device page (`https://microsoft.com/devicelogin`). Open the page
in any browser, enter the code, pick the account and accept the permissions it lists (mail only).
Microsoft calls the app "unverified" on that page; some organizations let only an administrator
consent for their users, and then an administrator approves it once, from the same page or in
Microsoft Entra (Enterprise applications → Consent and permissions).

The sign-in is kept on that machine: in the system's credential store when there is one, else in
the server's own folder in npm's cache under that user's home. Microsoft renews it as it is used
(90 days without use by default; your organization may shorten it). When it stops working, the
tool's calls and polls fail: run the command again.

## Add the tool

In Dispand, Settings → Tools → **Browse catalog** → **Microsoft 365 mail**: add the snippet it
shows under `mcpServers` in the runner's `config.json`, restart the runner, then **Pick the
runner** and **Add tool**. Its actions are listed through the runner.

The server's version is pinned in the snippet; the catalog moves it after checking a new one.

## Changing your mind

Remove the tool in Dispand, and on the runner's machine run the same command with `--logout`
in place of `--login`. To revoke the app's access on Microsoft's side, remove it from
[your account's apps](https://myapps.microsoft.com/) (work or school) or
[your Microsoft account's privacy page](https://account.microsoft.com/privacy) (personal).
