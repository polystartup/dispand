import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { harnesses } from "../db/schema.ts";
import { secretAad, type SecretBox } from "../secrets.ts";

export type CloudKind = "anthropic" | "openai" | "openai-compatible";
export const CLOUD_KINDS = ["anthropic", "openai", "openai-compatible"] as const satisfies readonly CloudKind[];

/** What a cloud session needs from its harness, without the key. */
export type CloudHarnessConfig = {
  kind: CloudKind;
  baseUrl?: string;
  model: string;
  systemPrompt: string;
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
  temperature?: number;
};

/** Where a harness's API key is sealed: its AAD names the row and the column. */
export const apiKeyAad = (harnessId: string) => secretAad("harnesses", harnessId, "api_key");

/**
 * A cloud harness with its API key opened. Server-only: the key goes to the provider and nowhere
 * else (no procedure returns it). Throws when the harness isn't the owner's cloud harness.
 */
export async function loadCloudHarness(db: Db, secrets: SecretBox, ownerId: string, id: string): Promise<CloudHarnessConfig & { apiKey?: string }> {
  const [row] = await db
    .select()
    .from(harnesses)
    .where(and(eq(harnesses.id, id), eq(harnesses.ownerId, ownerId), eq(harnesses.type, "cloud")));
  if (!row) throw new Error("Cloud harness not found");
  return {
    kind: row.kind as CloudKind,
    ...(row.baseUrl === null ? {} : { baseUrl: row.baseUrl }),
    model: row.model ?? "",
    systemPrompt: row.systemPrompt ?? "",
    ...(row.maxTokens === null ? {} : { maxTokens: row.maxTokens }),
    ...(row.effort === null ? {} : { effort: row.effort }),
    ...(row.temperature === null ? {} : { temperature: row.temperature }),
    ...(row.apiKeySealed === null ? {} : { apiKey: secrets.open(row.apiKeySealed, apiKeyAad(row.id)) }),
  };
}
