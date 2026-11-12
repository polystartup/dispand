import type { PollContinuation } from "../triggers/model.ts";
import type { ToolTransport } from "./mcp.ts";
import type { OAuthRequest } from "./oauth-provider.ts";

/** A setting the owner fills in when installing an HTTP entry (`{key}` in its header templates). */
export type CatalogSetting = { key: string; label: string; help: string };

/**
 * A poll trigger's settings that read the entry's new items (design 6.7), filled in when the
 * owner picks the tool for a poll: the action, its arguments (`{{lastPoll}}` or
 * `{{lastPollEpoch}}` for "newer than"), where the items and their ids are, and the continuation
 * when the action pages.
 */
export type PollPreset = {
  action: string;
  arguments: Record<string, unknown>;
  itemsPath: string;
  idPath: string;
  continuation?: PollContinuation;
};

/**
 * What every entry may add to a tool. `unasked`: the actions that run without asking when a
 * person gives the tool to an agent (design 6.4), in place of the ones the server calls
 * read-only; every other action asks. `pollable`: the actions a poll may read, in place of the
 * read-only ones. `poll`: its poll preset. `docs`: the set-up steps, a file of Dispand's repository.
 */
type Shared = { id: string; name: string; description: string; unasked?: string[]; pollable?: string[]; poll?: PollPreset; docs?: string };

/**
 * A tool Dispand knows how to set up. `http` entries become HTTP tools, their headers filled
 * from the settings (and sealed), or signing in with OAuth (`oauth`: the scopes the sign-in asks
 * for, and the authorization request's extra parameters), connected afterwards on the tool's
 * page. `runner` entries run on the owner's machine: Dispand only shows the snippet to add to the
 * runner's config, and their keys and sign-ins never leave that machine.
 */
export type CatalogEntry =
  | (Shared & {
      kind: "http";
      url: string;
      transport: ToolTransport;
      headers: { name: string; template: string }[];
      settings: CatalogSetting[];
      oauth?: OAuthRequest;
    })
  | (Shared & { kind: "runner"; server: { command: string; args: string[]; env: string[] } });

const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"];

/** Microsoft 365's mail actions: the server is started with these alone, so its sign-in asks for mail permissions only. */
const MICROSOFT_MAIL_TOOLS = [
  "list-mail-folder-messages",
  "list-mail-messages",
  "get-mail-message",
  "read-mail-text",
  "list-mail-attachments",
  "get-mail-attachment-content",
  "create-reply-draft",
];

export const CATALOG: readonly CatalogEntry[] = [
  {
    id: "github",
    name: "GitHub",
    description: "Repositories, issues, pull requests and code search, as the account of the token.",
    kind: "http",
    url: "https://api.githubcopilot.com/mcp/",
    transport: "streamable-http",
    headers: [{ name: "authorization", template: "Bearer {token}" }],
    settings: [
      {
        key: "token",
        label: "Personal access token",
        help: "A GitHub personal access token; the tool acts as its account, with its permissions.",
      },
    ],
  },
  {
    id: "firecrawl",
    name: "Firecrawl",
    description: "Scrape, crawl, map and search the web, with clean Markdown results.",
    kind: "http",
    url: "https://mcp.firecrawl.dev/v2/mcp",
    transport: "streamable-http",
    headers: [{ name: "authorization", template: "Bearer {apiKey}" }],
    settings: [{ key: "apiKey", label: "API key", help: "Your Firecrawl API key (fc-…), from firecrawl.dev." }],
  },
  {
    id: "fetch",
    name: "Fetch",
    description: "Fetches a web page and returns it as Markdown. Runs on your machine through a runner.",
    kind: "runner",
    server: { command: "uvx", args: ["mcp-server-fetch"], env: [] },
  },
  {
    id: "brave-search",
    name: "Brave Search",
    description: "Web, news, image and local search with the Brave Search API. Runs on your machine through a runner.",
    kind: "runner",
    server: { command: "npx", args: ["-y", "@brave/brave-search-mcp-server"], env: ["BRAVE_API_KEY"] },
  },
  {
    id: "gmail",
    name: "Gmail",
    description:
      "Search and read mail, and draft replies, through Google's hosted Gmail server. Only for Google Workspace accounts enrolled in Google's Workspace Developer Preview; any other account uses Gmail (on a runner). Signs in with your own Google Cloud OAuth client.",
    kind: "http",
    url: "https://gmailmcp.googleapis.com/mcp/v1",
    transport: "streamable-http",
    headers: [],
    settings: [],
    // Google lists every Gmail scope as supported: the sign-in asks for reading and drafts only,
    // and for a refresh token (`access_type=offline`, which Google gives on consent).
    oauth: { scopes: GMAIL_SCOPES, params: { access_type: "offline", prompt: "consent" } },
    // Search, read and draft run; sending doesn't exist with these scopes, labels and trash ask.
    unasked: ["search_threads", "get_thread", "get_message", "list_drafts", "get_draft", "list_labels", "create_draft"],
    pollable: ["search_threads"],
    // A new thread is an item: a reply in a thread already seen starts no Job.
    poll: {
      action: "search_threads",
      arguments: { query: "in:inbox after:{{lastPollEpoch}}", pageSize: 50 },
      itemsPath: "threads",
      idPath: "id",
      continuation: { path: "nextPageToken", argument: "pageToken" },
    },
    docs: "docs/services/gmail.md",
  },
  {
    id: "gmail-runner",
    name: "Gmail (on a runner)",
    description:
      "Search and read mail, and draft replies, for any Google account (personal Gmail included), through an open-source Gmail server on your machine, signed in with your own Google Cloud OAuth client.",
    kind: "runner",
    server: { command: "npx", args: ["-y", "@artymclabin/gmail-mcp@1.2.3"], env: [] },
    // Search, read and draft run; sending, deleting drafts and saving files on the machine ask.
    unasked: ["search_emails", "read_email", "get_thread", "list_inbox_threads", "get_inbox_with_threads", "list_email_labels", "draft_email"],
    pollable: ["list_inbox_threads"],
    // A new thread is an item: a reply in a thread already seen starts no Job. No continuation:
    // each poll reads the 50 newest threads since the last one.
    poll: { action: "list_inbox_threads", arguments: { query: "in:inbox after:{{lastPollEpoch}}", maxResults: 50 }, itemsPath: "threads", idPath: "threadId" },
    docs: "docs/services/gmail.md",
  },
  {
    id: "microsoft-365",
    name: "Microsoft 365 mail",
    description:
      "Search and read Outlook mail and its attachments, and draft replies, through a Microsoft Graph server on your machine, signed in with Microsoft's device code. Mail only: no calendar, files or Teams.",
    kind: "runner",
    server: { command: "npx", args: ["-y", "@softeria/ms-365-mcp-server@0.175.0", "--enabled-tools", `^(${MICROSOFT_MAIL_TOOLS.join("|")})$`], env: [] },
    // Search, read and reply drafts run; saving an attachment and the server's sign-in actions ask.
    unasked: MICROSOFT_MAIL_TOOLS.filter((name) => name !== "get-mail-attachment-content"),
    pollable: ["list-mail-folder-messages"],
    // The inbox only, so the agent's own drafts and sent replies are never items. Graph pages
    // through one query with its next link; `{{lastPoll}}` moves once a walk is over.
    poll: {
      action: "list-mail-folder-messages",
      arguments: {
        mailFolderId: "inbox",
        filter: "receivedDateTime ge {{lastPoll}}",
        orderby: "receivedDateTime asc",
        top: 25,
        select: "id,conversationId,subject,from,toRecipients,receivedDateTime,bodyPreview,hasAttachments",
        fetchAllPages: false,
      },
      itemsPath: "value",
      idPath: "id",
      continuation: { path: "@odata.nextLink", argument: "skiptoken" },
    },
    docs: "docs/services/microsoft-365.md",
  },
];

/** The catalog entry a tool was installed from, if it is still in the catalog. */
export const catalogEntry = (catalogId: string | null | undefined) => (catalogId ? CATALOG.find((e) => e.id === catalogId) : undefined);

/**
 * The actions that run unasked when a person gives the tool to an agent: its catalog entry's
 * choice, else the ones its server calls read-only. Read only then: later, neither changes
 * anything by itself.
 */
export function defaultUnasked(tool: { catalogId: string | null; actions: { name: string; readOnly?: boolean }[] }): string[] {
  const chosen = catalogEntry(tool.catalogId)?.unasked;
  if (chosen) return tool.actions.flatMap((a) => (chosen.includes(a.name) ? [a.name] : []));
  return tool.actions.flatMap((a) => (a.readOnly ? [a.name] : []));
}

/** Entries whose name or description contains `query`, ignoring case; all of them without one. */
export function searchCatalog(query?: string): CatalogEntry[] {
  const q = query?.trim().toLowerCase();
  if (!q) return [...CATALOG];
  return CATALOG.filter((e) => e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q));
}

/** An HTTP entry's headers filled from `settings`. Throws naming the first setting left empty. */
export function fillHeaders(entry: Extract<CatalogEntry, { kind: "http" }>, settings: Record<string, string>): Record<string, string> {
  for (const s of entry.settings) {
    if (!settings[s.key]?.trim()) throw new MissingSetting(s.label);
  }
  return Object.fromEntries(
    entry.headers.map((h) => [h.name, h.template.replace(/\{(\w+)\}/g, (_, key: string) => settings[key]!.trim())]),
  );
}

export class MissingSetting extends Error {
  override name = "MissingSetting";
  constructor(readonly label: string) {
    super(`${label} is required`);
  }
}

/**
 * What to add under `mcpServers` in the runner's `config.json` for a runner entry. Values are
 * placeholders: keys stay on the owner's machine and never reach Dispand.
 */
export function runnerSnippet(entry: Extract<CatalogEntry, { kind: "runner" }>): string {
  const { command, args, env } = entry.server;
  const server = { command, args, ...(env.length ? { env: Object.fromEntries(env.map((name) => [name, "<your key>"])) } : {}) };
  return JSON.stringify({ [entry.id]: server }, null, 2);
}
