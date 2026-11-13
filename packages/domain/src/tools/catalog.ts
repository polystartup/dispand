import type { PollContinuation } from "../triggers/model.ts";
import type { ToolAction, ToolTransport } from "./mcp.ts";
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
 * person gives the tool to an agent (design 6.4); every other action asks, whatever the server
 * says of it. `disabled`: actions initially unavailable workspace-wide. `pollable`: the actions a poll may read, in place of the
 * read-only ones. `poll`: its poll preset. `docs`: the set-up steps, a file of Dispand's repository.
 */
type Shared = { id: string; name: string; description: string; unasked?: string[]; disabled?: string[]; pollable?: string[]; poll?: PollPreset; docs?: string };

/**
 * An action an HTTP entry's server offers, as its documentation describes it: whether it only
 * reads, whether a poll may read it, and whether an agent given the tool asks before using it
 * (`ask`, the default for an action that doesn't only read), or is initially disabled workspace-wide. The tool starts with these, so its
 * flags and poll triggers can be set before its owner signs in; the first listing that succeeds
 * replaces them, as any listing does.
 */
export type CatalogAction = { name: string; description: string; readOnly?: true; pollable?: true; ask?: boolean; disabled?: true };

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
      actions: CatalogAction[];
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

type HttpEntry = Extract<CatalogEntry, { kind: "http" }>;

/** Whether a declared action runs without asking when a person gives the tool to an agent. */
const unaskedByDefault = (a: CatalogAction) => !(a.ask ?? !a.readOnly);

/**
 * An HTTP entry whose `unasked` and `pollable` come from its actions, so they can't disagree.
 * `pollable`: the ones marked, or, when none is, the ones the server calls read-only (the tool's
 * default). `unasked`: the declared ones that run unasked; an action the entry doesn't declare
 * asks (`defaultUnasked`).
 */
const http = (entry: Omit<HttpEntry, "kind" | "unasked" | "pollable">): HttpEntry => {
  const pollable = entry.actions.flatMap((a) => (a.pollable ? [a.name] : []));
  return { ...entry, kind: "http", unasked: entry.actions.flatMap((a) => (unaskedByDefault(a) ? [a.name] : [])), ...(pollable.length ? { pollable } : {}) };
};

const read = (name: string, description: string, more: Partial<CatalogAction> = {}): CatalogAction => ({ name, description, readOnly: true, ...more });
const write = (name: string, description: string, more: Partial<CatalogAction> = {}): CatalogAction => ({ name, description, ...more });

export const CATALOG: readonly CatalogEntry[] = [
  http({
    id: "github",
    name: "GitHub",
    description: "Repositories, issues, pull requests and code search, as the account of the token.",
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
    // The reads of its README's default toolsets (context, repos, issues, pull_requests, users),
    // all marked read-only there; the server lists many more once signed in, and those ask.
    actions: [
      read("get_me", "Get my user profile"),
      read("get_teams", "Get teams"),
      read("get_team_members", "Get team members"),
      read("search_repositories", "Search repositories"),
      read("get_file_contents", "Get file or directory contents"),
      read("search_code", "Search code"),
      read("search_commits", "Search commits"),
      read("list_branches", "List branches"),
      read("list_commits", "List commits"),
      read("get_commit", "Get commit details"),
      read("list_tags", "List tags"),
      read("get_tag", "Get tag details"),
      read("list_releases", "List releases"),
      read("get_latest_release", "Get latest release"),
      read("get_release_by_tag", "Get a release by tag name"),
      read("list_repository_collaborators", "List repository collaborators"),
      read("list_issues", "List issues"),
      read("search_issues", "Search issues"),
      read("issue_read", "Get issue details"),
      read("get_label", "Get a specific label from a repository"),
      read("list_issue_types", "List available issue types"),
      read("list_issue_fields", "List issue fields"),
      read("list_pull_requests", "List pull requests"),
      read("search_pull_requests", "Search pull requests"),
      read("pull_request_read", "Get details for a single pull request"),
      read("search_users", "Search users"),
      read("list_notifications", "List notifications"),
      write("issue_write", "Create or update issue/pull request"),
    ],
  }),
  http({
    id: "firecrawl",
    name: "Firecrawl",
    description: "Scrape, crawl, map and search the web, with clean Markdown results.",
    url: "https://mcp.firecrawl.dev/v2/mcp",
    transport: "streamable-http",
    headers: [{ name: "authorization", template: "Bearer {apiKey}" }],
    settings: [{ key: "apiKey", label: "API key", help: "Your Firecrawl API key (fc-…), from firecrawl.dev." }],
    // Each call spends the account's credits, and what it fetches can carry what the Job read.
    actions: [
      write("firecrawl_scrape", "Scrape one page's content, as Markdown"),
      write("firecrawl_map", "List the URLs of a site"),
      write("firecrawl_search", "Search the web, with optional content of the results"),
      write("firecrawl_crawl", "Crawl the pages under a site"),
      read("firecrawl_check_crawl_status", "Check the status of a crawl"),
    ],
  }),
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
  http({
    id: "gmail",
    name: "Gmail",
    description:
      "Search and read mail, and draft replies, through Google's hosted Gmail server. Only for Google Workspace accounts enrolled in Google's Workspace Developer Preview; any other account uses Gmail (on a runner). Signs in with your own Google Cloud OAuth client.",
    url: "https://gmailmcp.googleapis.com/mcp/v1",
    transport: "streamable-http",
    headers: [],
    settings: [],
    // Google lists every Gmail scope as supported: the sign-in asks for reading and drafts only,
    // and for a refresh token (`access_type=offline`, which Google gives on consent).
    oauth: { scopes: GMAIL_SCOPES, params: { access_type: "offline", prompt: "consent" } },
    // Search, read and draft run; sending doesn't exist with these scopes, labels and trash ask.
    actions: [
      read("search_threads", "Search threads", { pollable: true }),
      read("get_thread", "Get a thread"),
      read("get_message", "Get a message"),
      read("list_drafts", "List drafts"),
      read("get_draft", "Get a draft"),
      read("list_labels", "List labels"),
      write("create_draft", "Create a draft", { ask: false }),
    ],
    // A new thread is an item: a reply in a thread already seen starts no Job.
    poll: {
      action: "search_threads",
      arguments: { query: "in:inbox after:{{lastPollEpoch}}", pageSize: 50 },
      itemsPath: "threads",
      idPath: "id",
      continuation: { path: "nextPageToken", argument: "pageToken" },
    },
    docs: "docs/services/gmail.md",
  }),
  {
    id: "gmail-runner",
    name: "Gmail (on a runner)",
    description:
      "Search and read mail, and draft replies, for any Google account (personal Gmail included), through an open-source Gmail server on your machine, signed in with your own Google Cloud OAuth client. Its polls read at most 50 new threads each.",
    kind: "runner",
    server: { command: "npx", args: ["-y", "@artymclabin/gmail-mcp@1.2.3"], env: [] },
    // Search, read and draft run; sending, deleting drafts and saving files on the machine ask.
    unasked: ["search_emails", "read_email", "get_thread", "list_inbox_threads", "get_inbox_with_threads", "list_email_labels", "draft_email"],
    pollable: ["list_inbox_threads"],
    // A new thread is an item: a reply in a thread already seen starts no Job. No continuation:
    // the server returns the newest threads without a next page, so a poll reads at most the 50
    // newest since the last one, and older ones past that never start a Job (docs/services/gmail.md).
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

/** Workspace-wide defaults declared by a catalog entry, including its action flags. */
export function defaultDisabled(entry: { disabled?: string[]; actions?: { name: string; disabled?: true }[] }): string[] {
  return [...new Set([...(entry.disabled ?? []), ...(entry.actions ?? []).flatMap((a) => a.disabled ? [a.name] : [])])];
}

/** The enabled catalog/discovered actions of a tool, before any caller offers them. */
export function enabledActions<T extends { name: string }>(tool: { actions: T[]; disabled?: string[] }): T[] {
  return tool.actions.filter((a) => !tool.disabled?.includes(a.name));
}

/**
 * The actions that run unasked when a person gives the tool to an agent: for a tool from the
 * catalog, its entry's choice alone (an action the entry doesn't name asks, whatever its server
 * says); for any other tool, the ones its server calls read-only. Read only then: later, neither
 * changes anything by itself.
 */
export function defaultUnasked(tool: { catalogId: string | null; actions: { name: string; readOnly?: boolean }[]; disabled?: string[] }): string[] {
  const entry = catalogEntry(tool.catalogId);
  if (entry?.kind === "runner") return [...(entry.unasked ?? [])].filter((name) => !tool.disabled?.includes(name));
  return enabledActions(tool).flatMap((a) => ((entry ? (entry.unasked ?? []).includes(a.name) : a.readOnly === true) ? [a.name] : []));
}

/** Entries whose name or description contains `query`, ignoring case; all of them without one. */
export function searchCatalog(query?: string): CatalogEntry[] {
  const q = query?.trim().toLowerCase();
  if (!q) return [...CATALOG];
  return CATALOG.filter((e) => e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q));
}

/** An HTTP entry's headers filled from `settings`. Throws naming the first setting left empty. */
export function fillHeaders(entry: HttpEntry, settings: Record<string, string>): Record<string, string> {
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

/** An HTTP entry's actions as a tool lists them, until its first listing replaces them. */
export const declaredActions = (entry: HttpEntry): ToolAction[] =>
  entry.actions.map((a) => ({ name: a.name, description: a.description, inputSchema: { type: "object" }, ...(a.readOnly ? { readOnly: true as const } : {}) }));

/**
 * Whether a tool waits for its owner to sign in: an HTTP catalog entry with settings whose
 * headers aren't filled, or an OAuth tool not connected (or to re-authorize). `none` for a tool
 * that needs no sign-in of Dispand's (an open server, a runner's own).
 */
export function signInOf(row: { kind: string; catalogId: string | null; auth: string | null; oauthStatus: string | null; headersSealed: Record<string, unknown> }): "needed" | "connected" | "none" {
  if (row.kind !== "http") return "none";
  if (row.auth === "oauth") return row.oauthStatus === "connected" ? "connected" : "needed";
  const entry = catalogEntry(row.catalogId);
  if (entry?.kind === "http" && entry.settings.length > 0) return Object.keys(row.headersSealed).length > 0 ? "connected" : "needed";
  return row.auth === "headers" ? "connected" : "none";
}
