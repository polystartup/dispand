import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { orpc } from "../../lib/api.ts";
import type { Harness } from "./HarnessSheet.tsx";
import { FormField } from "./parts.tsx";

type CloudHarness = Extract<Harness, { type: "cloud" }>;
type Kind = CloudHarness["kind"];
type Effort = NonNullable<CloudHarness["effort"]>;

export const cloudKindLabels: Record<Kind, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "openai-compatible": "OpenAI-compatible",
};

const defaultModels: Record<Kind, string> = { anthropic: "claude-opus-5-5", openai: "", "openai-compatible": "" };
const NO_EFFORT = "default";
const OTHER = "__other";

type Props = {
  harness?: CloudHarness;
  onClose: () => void;
  onSaved: (harness: Harness, created: boolean) => void;
};

/** The form of a cloud harness: a provider's API with a key, sealed on the server. */
export function CloudHarnessForm({ harness, onClose, onSaved }: Props) {
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

  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: orpc.harnesses.key() });
  const create = useMutation(orpc.harnesses.create.mutationOptions({ onSuccess: invalidate }));
  const update = useMutation(orpc.harnesses.update.mutationOptions({ onSuccess: invalidate }));
  const del = useMutation(orpc.harnesses.delete.mutationOptions({ onSuccess: invalidate }));
  const busy = create.isPending || update.isPending || del.isPending;

  const keySet = harness?.apiKeySet === true && !clearKey;
  // A saved harness lists with its stored key until the form changes where it points or the key.
  const savedTarget = harness && !probe?.apiKey && (probe ? probe.kind === harness.kind && probe.baseUrl === (harness.baseUrl ?? "") : true);
  const modelsInput = savedTarget && harness.apiKeySet
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

  async function save() {
    setError(null);
    const fields = {
      type: "cloud" as const,
      name,
      kind,
      ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : clearKey ? { apiKey: "" } : {}),
      model: model.trim(),
      systemPrompt,
      ...(maxTokens.trim() ? { maxTokens: Number(maxTokens) } : {}),
      ...(effort !== NO_EFFORT && kind !== "openai-compatible" ? { effort } : {}),
      ...(temperature.trim() && kind === "openai-compatible" ? { temperature: Number(temperature) } : {}),
    };
    try {
      const saved = harness ? await update.mutateAsync({ ...fields, id: harness.id }) : await create.mutateAsync(fields);
      onSaved(saved, !harness);
    } catch (e) {
      const message = typeof e === "object" && e !== null && "code" in e && e.code === "BAD_REQUEST" && "message" in e ? String(e.message) : null;
      setError(message && message !== "Input validation failed" ? message : "Could not save the harness. Check the details and try again.");
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
      setError(used ? "An agent uses this harness. Delete or move the agent first." : "Could not delete the harness.");
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
      <FormField label="Name" htmlFor="harness-name">
        <Input id="harness-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required autoFocus />
      </FormField>

      <FormField label="Provider" htmlFor="harness-provider">
        <Select value={kind} onValueChange={(v) => changeKind(v as Kind)} disabled={!!harness}>
          <SelectTrigger id="harness-provider" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(cloudKindLabels).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>

      <FormField
        label={kind === "openai-compatible" ? "Base URL" : "Base URL (optional)"}
        htmlFor="harness-base-url"
        hint={kind === "openai-compatible" ? "The server's OpenAI-compatible API, such as https://host/v1." : "Leave empty for the provider's API."}
      >
        <Input
          id="harness-base-url"
          type="url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          onBlur={leave}
          maxLength={2000}
          required={kind === "openai-compatible"}
        />
      </FormField>

      <FormField
        label={kind === "openai-compatible" ? "API key (optional)" : "API key"}
        htmlFor="harness-api-key"
        hint="Stored encrypted. It is never shown again."
      >
        <Input
          id="harness-api-key"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          onBlur={leave}
          placeholder={keySet ? "Set: leave empty to keep" : ""}
          maxLength={4000}
          required={kind !== "openai-compatible" && !keySet}
        />
      </FormField>
      {harness?.apiKeySet && kind === "openai-compatible" && !apiKey && (
        <label className="flex items-center gap-2 text-[13px] text-muted">
          <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} />
          Remove the stored key
        </label>
      )}

      <FormField
        label="Model"
        htmlFor="harness-model"
        hint={models.isError ? "Couldn't list the models: type the model id." : modelsInput ? undefined : "Enter the key to pick from the provider's models."}
      >
        {picking ? (
          <Select
            value={listed.some((m) => m.id === model) ? model : ""}
            onValueChange={(v) => (v === OTHER ? setOtherModel(true) : setModel(v))}
          >
            <SelectTrigger id="harness-model" className="w-full">
              <SelectValue placeholder="Pick a model" />
            </SelectTrigger>
            <SelectContent>
              {listed.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.label}
                </SelectItem>
              ))}
              <SelectItem value={OTHER}>Other…</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <Input id="harness-model" value={model} onChange={(e) => setModel(e.target.value)} maxLength={200} required />
        )}
      </FormField>

      <FormField label="System prompt" htmlFor="harness-system-prompt" hint="Sent before the agent's own prompt in every session.">
        <Textarea id="harness-system-prompt" value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} rows={3} />
      </FormField>

      <FormField label="Max tokens (optional)" htmlFor="harness-max-tokens">
        <Input id="harness-max-tokens" type="number" min={1} max={1_000_000} step={1} value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} />
      </FormField>

      {kind === "openai-compatible" ? (
        <FormField label="Temperature (optional)" htmlFor="harness-temperature">
          <Input id="harness-temperature" type="number" min={0} max={2} step={0.1} value={temperature} onChange={(e) => setTemperature(e.target.value)} />
        </FormField>
      ) : (
        <FormField label="Effort" htmlFor="harness-effort">
          <Select value={effort} onValueChange={(v) => setEffort(v as Effort | typeof NO_EFFORT)}>
            <SelectTrigger id="harness-effort" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_EFFORT}>Provider default</SelectItem>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="high">High</SelectItem>
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
        <Button type="submit" disabled={busy || !name.trim() || !model.trim()}>
          {harness ? "Save" : "Create harness"}
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        {harness && (
          <Button type="button" variant="ghost" className="ml-auto text-danger" disabled={busy} onClick={() => void remove()}>
            Delete
          </Button>
        )}
      </div>
    </form>
  );
}
