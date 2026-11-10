import { z } from "zod";
import type { CloudKind } from "../harnesses/cloud.ts";

/** Where each provider's API lives when the harness doesn't set a base URL. */
export const DEFAULT_BASE_URLS: Record<Exclude<CloudKind, "openai-compatible">, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
};

export type ModelOption = { id: string; label: string };

/** A short, safe reason: never the provider's body, which may echo the key. */
export class ModelListError extends Error {
  override name = "ModelListError";
}

const Listing = z.object({
  data: z
    .array(z.object({ id: z.string().min(1).max(200), display_name: z.string().max(200).optional() }).loose())
    .max(5000),
});

const LISTING_TIMEOUT_MS = 10_000;

/**
 * The models a provider lists for this key: Anthropic `GET /v1/models`, OpenAI and compatible
 * servers `GET /models`. Redirects are refused, so the key only goes to the URL the owner set.
 */
export async function listModels(kind: CloudKind, baseUrl: string | undefined, apiKey: string | undefined, fetcher: typeof fetch = fetch): Promise<ModelOption[]> {
  const base = (baseUrl ?? (kind === "openai-compatible" ? "" : DEFAULT_BASE_URLS[kind])).replace(/\/+$/, "");
  const url = new URL(kind === "anthropic" ? `${base}/v1/models?limit=1000` : `${base}/models`);
  const headers: Record<string, string> =
    kind === "anthropic"
      ? { "anthropic-version": "2023-06-01", ...(apiKey ? { "x-api-key": apiKey } : {}) }
      : apiKey
        ? { authorization: `Bearer ${apiKey}` }
        : {};
  let response: Response;
  try {
    response = await fetcher(url, { headers, redirect: "error", signal: AbortSignal.timeout(LISTING_TIMEOUT_MS) });
  } catch {
    throw new ModelListError(`Couldn't reach ${url.host}`);
  }
  if (response.status === 401 || response.status === 403) throw new ModelListError("The provider refused the key");
  if (!response.ok) throw new ModelListError(`Couldn't reach ${url.host}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ModelListError(`Couldn't reach ${url.host}`);
  }
  const parsed = Listing.safeParse(body);
  if (!parsed.success) throw new ModelListError(`Couldn't reach ${url.host}`);
  return parsed.data.data.map((m) => ({ id: m.id, label: m.display_name || m.id }));
}
