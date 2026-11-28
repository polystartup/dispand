import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { orpc } from "../../lib/api.ts";
import { refusal } from "../../lib/refusal.ts";
import { cloudErrors, cloudInput, NO_EFFORT } from "./cloud-harness-input.ts";
import type { Harness } from "./HarnessSheet.tsx";
import { FormField } from "./parts.tsx";

type CloudHarness = Extract<Harness, { type: "cloud" }>;
type Kind = CloudHarness["kind"];
type Effort = NonNullable<CloudHarness["effort"]>;

/** The providers, each named by `harnesses:provider.<kind>`. */
const KINDS: Kind[] = ["anthropic", "openai", "openai-compatible"];

const defaultModels: Record<Kind, string> = { anthropic: "claude-opus-5-5", openai: "", "openai-compatible": "" };
const OTHER = "__other";

type Props = {
  harness?: CloudHarness;
  onClose: () => void;
  onSaved: (harness: Harness, created: boolean) => void;
};

/** The form of a cloud harness: a provider's API with a key, sealed on the server. */
export function CloudHarnessForm({ harness, onClose, onSaved }: Props) {
  const { t, i18n } = useTranslation("harnesses");
  const [name, setName] = useState(harness?.name ?? "");
  const [kind, setKind] = useState<Kind>(harness?.kind ?? "anthropic");
  const [baseUrl, setBaseUrl] = useState(harness?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [model, setModel] = useState(harness?.model ?? defaultModels.anthropic);
  const [otherModel, setOtherModel] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState(harness?.systemPrompt ?? "");
  const [maxTokens, setMaxTokens] = useState(harness?.maxTokens?.toString() ?? "");
  const [effort, setEffort] = useState<Effort | typeof NO_EFFORT>(harness?.effort ?? NO_EFFORT);
  const [temperature, setTemperature] = useState(harness?.temperature?.toString() ?? "");
  const [error, setError] = useState<string | null>(null);
  // What the model list was last asked for: set when the key or the base URL field is left.
  const [probe, setProbe] = useState<{ kind: Kind; baseUrl: string; apiKey: string } | null>(null);

  const create = useMutation(orpc.harnesses.create.mutationOptions());
  const update = useMutation(orpc.harnesses.update.mutationOptions());
  const del = useMutation(orpc.harnesses.delete.mutationOptions());
  const busy = create.isPending || update.isPending || del.isPending;

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
    setKind(next);
    if (!harness && (!model || model === defaultModels[kind])) setModel(defaultModels[next]);
    setProbe({ kind: next, baseUrl: baseUrl.trim(), apiKey: apiKey.trim() });
  }

  const input = cloudInput({ name, kind, baseUrl, apiKey, clearKey, model, systemPrompt, maxTokens, effort, temperature });
  // Checked on the first submit, then as the fields change, so an error goes as its field is put right.
  const [attempted, setAttempted] = useState(false);
  const errors = attempted ? cloudErrors(input, harness, t, i18n) : {};

  async function save() {
    setError(null);
    setAttempted(true);
    if (Object.keys(cloudErrors(input, harness, t, i18n)).length) return;
    try {
      const saved = harness ? await update.mutateAsync({ ...input, id: harness.id }) : await create.mutateAsync(input);
      onSaved(saved, !harness);
    } catch (e) {
      setError(refusal(e, t("sheet.saveFailed"), ["BAD_REQUEST"]));
    }
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
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <FormField label={t("sheet.name")} htmlFor="harness-name" error={errors.name}>
        {/* eslint-disable-next-line jsx-a11y/no-autofocus -- focus moves into the sheet just opened */}
        <Input id="harness-name" value={name} onChange={(e) => setName(e.target.value)} aria-required autoFocus />
      </FormField>

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

      <FormField
        label={kind === "openai-compatible" ? t("cloud.baseUrl") : t("cloud.baseUrlOptional")}
        htmlFor="harness-base-url"
        hint={kind === "openai-compatible" ? t("cloud.baseUrlHint") : t("cloud.baseUrlDefault")}
        error={errors.baseUrl}
      >
        <Input
          id="harness-base-url"
          type="url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          onBlur={leave}
          aria-required={kind === "openai-compatible"}
        />
      </FormField>

      <FormField
        label={kind === "openai-compatible" ? t("cloud.apiKeyOptional") : t("cloud.apiKey")}
        htmlFor="harness-api-key"
        hint={t("cloud.apiKeyHint")}
        error={errors.apiKey}
      >
        <Input
          id="harness-api-key"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          onBlur={leave}
          placeholder={keySet ? t("cloud.keySet") : ""}
          aria-required={kind !== "openai-compatible" && !keySet}
        />
      </FormField>
      {harness?.apiKeySet && kind === "openai-compatible" && !apiKey && (
        <label className="flex items-center gap-2 text-[13px] text-muted">
          <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} />
          {t("cloud.removeKey")}
        </label>
      )}

      <FormField
        label={t("cloud.model")}
        htmlFor="harness-model"
        hint={models.isError ? t("cloud.modelsFailed") : modelsInput ? undefined : t("cloud.enterKey")}
        error={errors.model}
      >
        {picking ? (
          <Select value={listed.some((m) => m.id === model) ? model : ""} onValueChange={(v) => (v === OTHER ? setOtherModel(true) : setModel(v))}>
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
        ) : (
          <Input id="harness-model" value={model} onChange={(e) => setModel(e.target.value)} aria-required />
        )}
      </FormField>

      <FormField label={t("cloud.systemPrompt")} htmlFor="harness-system-prompt" hint={t("cloud.systemPromptHint")} error={errors.systemPrompt}>
        <Textarea id="harness-system-prompt" value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} rows={3} />
      </FormField>

      <FormField label={t("cloud.maxTokens")} htmlFor="harness-max-tokens" error={errors.maxTokens}>
        <Input id="harness-max-tokens" type="number" step={1} value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} />
      </FormField>

      {kind === "openai-compatible" ? (
        <FormField label={t("cloud.temperature")} htmlFor="harness-temperature" error={errors.temperature}>
          <Input id="harness-temperature" type="number" step={0.1} value={temperature} onChange={(e) => setTemperature(e.target.value)} />
        </FormField>
      ) : (
        <FormField label={t("cloud.effort")} htmlFor="harness-effort">
          <Select value={effort} onValueChange={(v) => setEffort(v as Effort | typeof NO_EFFORT)}>
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
