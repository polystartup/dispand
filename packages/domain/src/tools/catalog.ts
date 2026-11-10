import type { ToolTransport } from "./mcp.ts";

/** A setting the owner fills in when installing an HTTP entry (`{key}` in its header templates). */
export type CatalogSetting = { key: string; label: string; help: string };

/**
 * A tool Dispand knows how to set up. `http` entries become HTTP tools, their headers filled
 * from the settings (and sealed). `runner` entries run on the owner's machine: Dispand only
 * shows the snippet to add to the runner's config, and their keys never leave that machine.
 */
export type CatalogEntry =
  | {
      id: string;
      name: string;
      description: string;
      kind: "http";
      url: string;
      transport: ToolTransport;
      headers: { name: string; template: string }[];
      settings: CatalogSetting[];
    }
  | { id: string; name: string; description: string; kind: "runner"; server: { command: string; args: string[]; env: string[] } };

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
];

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
