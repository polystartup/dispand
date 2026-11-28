import { CloudFields, cloudRefusal } from "@dispand/domain/harnesses/model";
import { say } from "@dispand/domain/messages/index.ts";
import type { i18n, TFunction } from "i18next";
import type { z } from "zod";
import { fieldErrors } from "../../lib/field-errors.ts";
import { messageText } from "../../lib/message.ts";
import type { Harness } from "./HarnessSheet.tsx";

type CloudHarness = Extract<Harness, { type: "cloud" }>;

export const NO_EFFORT = "default";

type Values = {
  name: string;
  kind: CloudHarness["kind"];
  baseUrl: string;
  apiKey: string;
  clearKey: boolean;
  model: string;
  systemPrompt: string;
  maxTokens: string;
  effort: NonNullable<CloudHarness["effort"]> | typeof NO_EFFORT;
  temperature: string;
};

/** What the procedures take, from the form's values: what is empty is left out. */
export function cloudInput(v: Values) {
  return {
    type: "cloud" as const,
    name: v.name,
    kind: v.kind,
    ...(v.baseUrl.trim() ? { baseUrl: v.baseUrl.trim() } : {}),
    ...(v.apiKey.trim() ? { apiKey: v.apiKey.trim() } : v.clearKey ? { apiKey: "" } : {}),
    model: v.model.trim(),
    systemPrompt: v.systemPrompt,
    ...(v.maxTokens.trim() ? { maxTokens: Number(v.maxTokens) } : {}),
    ...(v.effort !== NO_EFFORT && v.kind !== "openai-compatible" ? { effort: v.effort } : {}),
    ...(v.temperature.trim() && v.kind === "openai-compatible" ? { temperature: Number(v.temperature) } : {}),
  } satisfies z.input<typeof CloudFields>;
}

/** The fields the procedure would refuse, each with its reason in the page's language. */
export function cloudErrors(input: ReturnType<typeof cloudInput>, harness: CloudHarness | undefined, t: TFunction<"harnesses">, i18n: i18n) {
  const errors = fieldErrors(CloudFields.safeParse(input).error, (field, issue) =>
    t(`cloud.invalid.${field === "baseUrl" && issue.code === "custom" ? "baseUrlCredentials" : field}` as never),
  );
  // Not on an address that failed to parse: the rule reads it.
  if (errors.baseUrl) return errors;
  // As on the server: an update that sends no key keeps the stored one, but only for the URL it was saved for.
  const kept = harness?.apiKeySet === true && (input.baseUrl ?? null) === (harness.baseUrl ?? null);
  const refused = cloudRefusal(input.kind, input.baseUrl, "apiKey" in input ? input.apiKey !== "" : kept);
  if (refused) errors[refused.field] ??= messageText(i18n, say(refused.key));
  return errors;
}
