import { z } from "zod";
import type { MessageKey } from "../messages/index.ts";
import { StorableText } from "../text.ts";

// Pure: the web form checks what it sends with the same schema the procedures do.

export type CloudKind = "anthropic" | "openai" | "openai-compatible";
export const CLOUD_KINDS = ["anthropic", "openai", "openai-compatible"] as const satisfies readonly CloudKind[];

export const Name = z.string().trim().min(1).max(100);

/** What a cloud harness is created or updated with. */
export const CloudFields = z.object({
  type: z.literal("cloud"),
  name: Name,
  kind: z.enum(CLOUD_KINDS),
  baseUrl: z
    .url({ protocol: /^https?$/ })
    .max(2000)
    .optional(),
  // Omitted on update: keep the stored key. "": no key (clears it on update).
  apiKey: z.string().trim().max(4000).optional(),
  model: z.string().trim().min(1).max(200),
  systemPrompt: StorableText(100_000),
  maxTokens: z.int().min(1).max(1_000_000).optional(),
  effort: z.enum(["low", "medium", "high"]).optional(),
  temperature: z.number().min(0).max(2).optional(),
});

/** Plain http only reaches this machine: a key never crosses the network in clear. */
export function isLoopback(url: URL): boolean {
  const host = url.hostname;
  return host === "localhost" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/** The rule a cloud harness breaks that the schema can't say alone (`hasKey`: whether it will hold a key), and the field it is on. */
export function cloudRefusal(kind: CloudKind, baseUrl: string | undefined, hasKey: boolean): { field: "baseUrl" | "apiKey"; key: MessageKey } | undefined {
  if (kind === "openai-compatible" && !baseUrl) return { field: "baseUrl", key: "harness.cloud.needsBaseUrl" };
  if (kind !== "openai-compatible" && !hasKey) return { field: "apiKey", key: "harness.cloud.needsKey" };
  if (hasKey && baseUrl && new URL(baseUrl).protocol === "http:" && !isLoopback(new URL(baseUrl))) return { field: "apiKey", key: "harness.cloud.keyHttps" };
}
