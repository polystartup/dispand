import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { api } from "../../lib/api.ts";
import { orpc } from "../../lib/api.ts";
import { AddRunner } from "./AddRunner.tsx";
import { CloudHarnessForm } from "./CloudHarnessForm.tsx";
import { FormField } from "./parts.tsx";

export type Runner = Awaited<ReturnType<typeof api.runners.list>>[number];
export type Harness = Awaited<ReturnType<typeof api.harnesses.list>>[number];
type CliHarness = Extract<Harness, { type: "cli" }>;

const ADD_RUNNER = "__add-runner";

/** The tabs of the harness settings. */
export const harnessTabs = [
  { to: "/settings/harnesses", label: "Harnesses" },
  { to: "/settings/harnesses/runners", label: "Runners" },
];

export const permissionLabels = {
  default: "Ask before acting",
  acceptEdits: "Accept file edits",
  plan: "Plan only",
  bypassPermissions: "Bypass permissions",
} as const;

export const cliLabels = { "claude-code": "Claude Code", codex: "Codex" } as const;

/** The permission modes each CLI's sessions accept (the runner protocol's). */
const cliPermissions: Record<CliHarness["kind"], (keyof typeof permissionLabels)[]> = {
  "claude-code": ["default", "acceptEdits", "plan", "bypassPermissions"],
  codex: ["default", "bypassPermissions"],
};

/** A CLI and its version as the runner last reported it, e.g. "Claude Code 2.1.0". */
export function cliVersion(kind: CliHarness["kind"], runner: Runner | undefined): string {
  const version = kind === "codex" ? runner?.clis.codex?.version : runner?.clis.claude;
  return version ? `${cliLabels[kind]} ${version}` : cliLabels[kind];
}

type Props = {
  /** The harness being edited; absent when creating. */
  harness?: Harness;
  runners: Runner[];
  onClose: () => void;
  onSaved: (harness: Harness, created: boolean) => void;
};

/** The "New harness" sheet (Cloud or CLI), or the editor of an existing harness. Mount it only while open. */
export function HarnessSheet({ harness, runners, onClose, onSaved }: Props) {
  const [type, setType] = useState<Harness["type"] | null>(harness?.type ?? null);
  const [step, setStep] = useState<"form" | "runner">("form");
  const title =
    type === null ? "New harness" : step === "runner" ? "Add a runner" : harness ? "Edit harness" : type === "cloud" ? "New cloud harness" : "New CLI harness";
  const description =
    type === null
      ? "Where your agents run."
      : type === "cloud"
        ? "A provider's API (Anthropic, OpenAI or an OpenAI-compatible server), with your API key."
        : step === "runner"
          ? "A runner is a small service on the machine where Claude Code or Codex is installed."
          : "Claude Code or Codex on one of your machines, through a runner.";

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto bg-surface sm:max-w-md">
        <SheetHeader className="px-6 pt-6">
          <SheetTitle className="text-[20px] tracking-tight">{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        <div className="px-6 pb-6">
          {type === null ? (
            <div className="grid gap-3">
              {(
                [
                  ["cloud", "Cloud", "Anthropic, OpenAI or an OpenAI-compatible API, with your key."],
                  ["cli", "CLI", "Claude Code or Codex on one of your machines, through a runner."],
                ] as const
              ).map(([value, label, text]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setType(value)}
                  className="rounded-xl border border-line px-4 py-3 text-left transition hover:bg-hover"
                >
                  <span className="block text-[15px] font-medium">{label}</span>
                  <span className="block text-[13px] text-muted">{text}</span>
                </button>
              ))}
            </div>
          ) : type === "cloud" ? (
            <CloudHarnessForm harness={harness?.type === "cloud" ? harness : undefined} onClose={onClose} onSaved={onSaved} />
          ) : (
            <CliHarnessForm
              harness={harness?.type === "cli" ? harness : undefined}
              runners={runners}
              step={step}
              setStep={setStep}
              onClose={onClose}
              onSaved={onSaved}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * What the picked runner last reported about Codex: its version and sign-in, or that it has none.
 * Nothing for Claude Code, nor for a runner that hasn't reported yet.
 */
function cliStatus(kind: CliHarness["kind"], runner: Runner | undefined): string | undefined {
  if (kind !== "codex" || !runner?.lastSeenAt) return undefined;
  const codex = runner.clis.codex;
  if (!codex) return `Codex isn't installed on ${runner.name}.`;
  return codex.signedIn ? `Codex ${codex.version}, signed in.` : `Codex ${codex.version}. Not signed in: run \`codex login\` on ${runner.name}, then restart its runner.`;
}

type CliProps = Omit<Props, "harness"> & {
  harness?: CliHarness;
  step: "form" | "runner";
  setStep: (step: "form" | "runner") => void;
};

function CliHarnessForm({ harness, runners, step, setStep, onClose, onSaved }: CliProps) {
  const [name, setName] = useState(harness?.name ?? "");
  const [runnerId, setRunnerId] = useState(harness?.runnerId ?? "");
  const [kind, setKind] = useState<CliHarness["kind"]>(harness?.kind ?? "claude-code");
  const [permissionMode, setPermissionMode] = useState<keyof typeof permissionLabels>(harness?.permissionMode ?? "default");
  const [model, setModel] = useState(harness?.model ?? "");
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: orpc.harnesses.key() });
  const create = useMutation(orpc.harnesses.create.mutationOptions({ onSuccess: invalidate }));
  const update = useMutation(orpc.harnesses.update.mutationOptions({ onSuccess: invalidate }));
  const del = useMutation(orpc.harnesses.delete.mutationOptions({ onSuccess: invalidate }));
  const busy = create.isPending || update.isPending || del.isPending;

  async function save() {
    setError(null);
    const shared = { type: "cli" as const, name, runnerId, ...(model.trim() ? { model: model.trim() } : {}) };
    const fields =
      kind === "codex"
        ? { ...shared, kind, permissionMode: permissionMode as Extract<CliHarness, { kind: "codex" }>["permissionMode"] }
        : { ...shared, kind, permissionMode };
    try {
      const saved = harness ? await update.mutateAsync({ ...fields, id: harness.id }) : await create.mutateAsync(fields);
      onSaved(saved, !harness);
    } catch {
      setError("Could not save the harness. Check the details and try again.");
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

  return (
    <>
          {step === "runner" ? (
            <AddRunner
              onCancel={() => setStep("form")}
              onConnected={(id) => {
                setRunnerId(id);
                setStep("form");
              }}
            />
          ) : (
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

              <FormField label="CLI" htmlFor="harness-cli">
                <Select
                  value={kind}
                  onValueChange={(v) => {
                    const next = v as CliHarness["kind"];
                    setKind(next);
                    // Codex has no "Accept file edits" or "Plan only".
                    if (!cliPermissions[next].includes(permissionMode)) setPermissionMode("default");
                  }}
                >
                  <SelectTrigger id="harness-cli" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(cliLabels).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>

              <FormField label="Runner" htmlFor="harness-runner" hint={cliStatus(kind, runners.find((r) => r.id === runnerId))}>
                <Select
                  value={runnerId}
                  onValueChange={(v) => (v === ADD_RUNNER ? setStep("runner") : setRunnerId(v))}
                >
                  <SelectTrigger id="harness-runner" className="w-full">
                    <SelectValue placeholder="Pick a runner" />
                  </SelectTrigger>
                  <SelectContent>
                    {runners.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name} {r.status === "online" ? "" : r.status === "outdated" ? "(needs an update)" : "(offline)"}
                      </SelectItem>
                    ))}
                    <SelectItem value={ADD_RUNNER}>Add a runner…</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>

              <FormField
                label="Permissions"
                htmlFor="harness-permissions"
                hint={permissionMode === "bypassPermissions" ? "Only works if the runner's own config allows it." : undefined}
              >
                <Select value={permissionMode} onValueChange={(v) => setPermissionMode(v as keyof typeof permissionLabels)}>
                  <SelectTrigger id="harness-permissions" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {cliPermissions[kind].map((value) => (
                      <SelectItem key={value} value={value}>
                        {permissionLabels[value]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>

              <FormField label="Default model (optional)" htmlFor="harness-model" hint="Leave empty for the CLI's default. An agent can pick its own.">
                <Input id="harness-model" value={model} onChange={(e) => setModel(e.target.value)} maxLength={100} />
              </FormField>

              {error && (
                <p role="alert" className="text-[13px] text-danger">
                  {error}
                </p>
              )}
              <div className="flex items-center gap-2 pt-1">
                <Button type="submit" disabled={busy || !name.trim() || !runnerId}>
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
          )}
    </>
  );
}
