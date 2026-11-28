import { CloudFields, cloudRefusal } from "@dispand/domain/harnesses/model";
import { say } from "@dispand/domain/messages/index.ts";
import type { i18n, TFunction } from "i18next";
import { useMutation, useQuery } from "@tanstack/react-query";
import { revalidateLogic, useStore } from "@tanstack/react-form";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { orpc } from "../../lib/api.ts";
import { messageText } from "../../lib/message.ts";
import { refusal } from "../../lib/refusal.ts";
import type { Harness } from "./HarnessSheet.tsx";
import { useAppForm } from "./form.tsx";
import { FormField } from "./parts.tsx";

type CloudHarness = Extract<Harness, { type: "cloud" }>;
type Kind = CloudHarness["kind"];
type Effort = NonNullable<CloudHarness["effort"]>;

/** The providers, each named by `harnesses:provider.<kind>`. */
const KINDS: Kind[] = ["anthropic", "openai", "openai-compatible"];

const defaultModels: Record<Kind, string> = { anthropic: "claude-opus-5-5", openai: "", "openai-compatible": "" };
const NO_EFFORT = "default";
const OTHER = "__other";

type Props = {
  harness?: CloudHarness;
  onClose: () => void;
  onSaved: (harness: Harness, created: boolean) => void;
};

type Values = {
  name: string;
  kind: Kind;
  baseUrl: string;
  apiKey: string;
  clearKey: boolean;
  model: string;
  systemPrompt: string;
  maxTokens: string;
  effort: Effort | typeof NO_EFFORT;
  temperature: string;
};

/** What the procedures take, from the form's values: what is empty is left out. */
function toInput(v: Values) {
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
  };
}

/** The fields the procedure would refuse, each with its reason in the page's language. */
function invalid(v: Values, harness: CloudHarness | undefined, t: TFunction<"harnesses">, i18n: i18n) {
  const input = toInput(v);
  const fields: Record<string, string> = {};
  for (const issue of CloudFields.safeParse(input).error?.issues ?? []) fields[String(issue.path[0])] ??= t(`cloud.invalid.${String(issue.path[0])}` as never);
  // As on the server: an update that sends no key keeps the stored one, but only for the URL it was saved for.
  const kept = harness?.apiKeySet === true && (input.baseUrl ?? null) === (harness.baseUrl ?? null);
  const refused = cloudRefusal(input.kind, input.baseUrl, input.apiKey === undefined ? kept : input.apiKey !== "");
  if (refused) fields[refused.field] ??= messageText(i18n, say(refused.key));
  return { fields };
}

/** The form of a cloud harness: a provider's API with a key, sealed on the server. */
export function CloudHarnessForm({ harness, onClose, onSaved }: Props) {
  const { t, i18n } = useTranslation("harnesses");
  const [error, setError] = useState<string | null>(null);
  const [otherModel, setOtherModel] = useState(false);
  // What the model list was last asked for: set when the key or the base URL field is left.
  const [probe, setProbe] = useState<{ kind: Kind; baseUrl: string; apiKey: string } | null>(null);

  const create = useMutation(orpc.harnesses.create.mutationOptions());
  const update = useMutation(orpc.harnesses.update.mutationOptions());
  const del = useMutation(orpc.harnesses.delete.mutationOptions());

  const form = useAppForm({
    defaultValues: {
      name: harness?.name ?? "",
      kind: harness?.kind ?? "anthropic",
      baseUrl: harness?.baseUrl ?? "",
      apiKey: "",
      clearKey: false,
      model: harness?.model ?? defaultModels.anthropic,
      systemPrompt: harness?.systemPrompt ?? "",
      maxTokens: harness?.maxTokens?.toString() ?? "",
      effort: harness?.effort ?? NO_EFFORT,
      temperature: harness?.temperature?.toString() ?? "",
    } as Values,
    // Checked on submit; then on every change, so an error goes as the field is put right.
    validationLogic: revalidateLogic({ mode: "submit", modeAfterSubmission: "change" }),
    validators: { onDynamic: ({ value }) => invalid(value, harness, t, i18n) },
    onSubmit: async ({ value }) => {
      setError(null);
      try {
        const fields = toInput(value);
        const saved = harness ? await update.mutateAsync({ ...fields, id: harness.id }) : await create.mutateAsync(fields);
        onSaved(saved, !harness);
      } catch (e) {
        setError(refusal(e, t("sheet.saveFailed"), ["BAD_REQUEST"]));
      }
    },
  });
  const { kind, baseUrl, apiKey, clearKey, model } = useStore(form.store, (s) => s.values);
  const busy = useStore(form.store, (s) => s.isSubmitting) || del.isPending;

  const keySet = harness?.apiKeySet === true && !clearKey;
  // A saved harness lists with its stored key until the form changes where it points or the key.
  const savedTarget = harness && !probe?.apiKey && (probe ? probe.kind === harness.kind && probe.baseUrl === (harness.baseUrl ?? "") : true);
  const modelsInput =
    savedTarget && harness.apiKeySet
      ? { harnessId: harness.id }
      : probe && (probe.apiKey || probe.kind === "openai-compatible") && (probe.kind !== "openai-compatible" || probe.baseUrl)
        ? { kind: probe.kind, ...(probe.baseUrl ? { baseUrl: probe.baseUrl } : {}), ...(probe.apiKey ? { apiKey: probe.apiKey } : {}) }
        : null;
  const models = useQuery({
    ...orpc.harnesses.models.queryOptions({ input: modelsInput ?? { harnessId: "" } }),
    enabled: modelsInput !== null,
    retry: false,
    staleTime: 60_000,
  });
  const listed = models.data ?? [];
  const picking = listed.length > 0 && !otherModel;

  function changeKind(next: Kind) {
    form.setFieldValue("kind", next);
    if (!harness && (!model || model === defaultModels[kind])) form.setFieldValue("model", defaultModels[next]);
    setProbe({ kind: next, baseUrl: baseUrl.trim(), apiKey: apiKey.trim() });
  }

  async function remove() {
    if (!harness) return;
    setError(null);
    try {
      await del.mutateAsync({ id: harness.id });
      onSaved(harness, false);
    } catch (e) {
      const used = typeof e === "object" && e !== null && "code" in e && e.code === "CONFLICT";
      setError(used ? t("sheet.inUse") : t("sheet.deleteFailed"));
    }
  }

  const leave = () => setProbe({ kind, baseUrl: baseUrl.trim(), apiKey: apiKey.trim() });

  return (
    <form
      noValidate
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
    >
      <form.AppField name="name">
        {/* eslint-disable-next-line jsx-a11y/no-autofocus -- focus moves into the sheet just opened */}
        {(f) => <f.TextField id="harness-name" label={t("sheet.name")} autoFocus />}
      </form.AppField>

      <FormField label={t("cloud.provider")} htmlFor="harness-provider">
        <Select value={kind} onValueChange={(v) => changeKind(v as Kind)} disabled={!!harness}>
          <SelectTrigger id="harness-provider" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KINDS.map((value) => (
              <SelectItem key={value} value={value}>
                {t(`provider.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>

      <form.AppField name="baseUrl">
        {(f) => (
          <f.TextField
            id="harness-base-url"
            label={kind === "openai-compatible" ? t("cloud.baseUrl") : t("cloud.baseUrlOptional")}
            hint={kind === "openai-compatible" ? t("cloud.baseUrlHint") : t("cloud.baseUrlDefault")}
            type="url"
            onBlur={leave}
          />
        )}
      </form.AppField>

      <form.AppField name="apiKey">
        {(f) => (
          <f.TextField
            id="harness-api-key"
            label={kind === "openai-compatible" ? t("cloud.apiKeyOptional") : t("cloud.apiKey")}
            hint={t("cloud.apiKeyHint")}
            type="password"
            autoComplete="off"
            placeholder={keySet ? t("cloud.keySet") : ""}
            onBlur={leave}
          />
        )}
      </form.AppField>
      {harness?.apiKeySet && kind === "openai-compatible" && !apiKey && (
        <label className="flex items-center gap-2 text-[13px] text-muted">
          <input type="checkbox" checked={clearKey} onChange={(e) => form.setFieldValue("clearKey", e.target.checked)} />
          {t("cloud.removeKey")}
        </label>
      )}

      <form.AppField name="model">
        {(f) =>
          picking ? (
            <FormField label={t("cloud.model")} htmlFor="harness-model" error={f.state.meta.errors.filter(Boolean).join(" ") || undefined}>
              <Select value={listed.some((m) => m.id === model) ? model : ""} onValueChange={(v) => (v === OTHER ? setOtherModel(true) : f.handleChange(v))}>
                <SelectTrigger id="harness-model" className="w-full">
                  <SelectValue placeholder={t("sheet.pickModel")} />
                </SelectTrigger>
                <SelectContent>
                  {listed.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.label}
                    </SelectItem>
                  ))}
                  <SelectItem value={OTHER}>{t("cloud.other")}</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          ) : (
            <f.TextField
              id="harness-model"
              label={t("cloud.model")}
              hint={models.isError ? t("cloud.modelsFailed") : modelsInput ? undefined : t("cloud.enterKey")}
            />
          )
        }
      </form.AppField>

      <form.AppField name="systemPrompt">
        {(f) => <f.TextField id="harness-system-prompt" label={t("cloud.systemPrompt")} hint={t("cloud.systemPromptHint")} multiline rows={3} />}
      </form.AppField>

      <form.AppField name="maxTokens">{(f) => <f.TextField id="harness-max-tokens" label={t("cloud.maxTokens")} type="number" step={1} />}</form.AppField>

      {kind === "openai-compatible" ? (
        <form.AppField name="temperature">
          {(f) => <f.TextField id="harness-temperature" label={t("cloud.temperature")} type="number" step={0.1} />}
        </form.AppField>
      ) : (
        <form.Field name="effort">
          {(f) => (
            <FormField label={t("cloud.effort")} htmlFor="harness-effort">
              <Select value={f.state.value} onValueChange={(v) => f.handleChange(v as Effort | typeof NO_EFFORT)}>
                <SelectTrigger id="harness-effort" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_EFFORT}>{t("cloud.effortDefault")}</SelectItem>
                  <SelectItem value="low">{t("cloud.low")}</SelectItem>
                  <SelectItem value="medium">{t("cloud.medium")}</SelectItem>
                  <SelectItem value="high">{t("cloud.high")}</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          )}
        </form.Field>
      )}

      {error && (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2 pt-1">
        <Button type="submit" disabled={busy}>
          {harness ? t("sheet.save") : t("sheet.create")}
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          {t("sheet.cancel")}
        </Button>
        {harness && (
          <Button type="button" variant="ghost" className="ml-auto text-danger" disabled={busy} onClick={() => void remove()}>
            {t("sheet.delete")}
          </Button>
        )}
      </div>
    </form>
  );
}
