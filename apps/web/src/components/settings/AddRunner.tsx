import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { orpc } from "../../lib/api.ts";
import { FormField } from "./parts.tsx";

/**
 * Creates a runner, shows the install command with its single-use code, and waits for the
 * runner to come online. The wait polls `runners.list` every 2 s.
 */
export function AddRunner({ onConnected, onCancel }: { onConnected: (runnerId: string) => void; onCancel: () => void }) {
  const { t } = useTranslation("harnesses");
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ runnerId: string; installCommand: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const createRunner = useMutation(
    orpc.runners.create.mutationOptions({ onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.runners.key() }) }),
  );
  const [copied, setCopied] = useState(false);

  async function create() {
    setError(null);
    try {
      setCreated(await createRunner.mutateAsync({ name }));
    } catch {
      setError(t("addRunner.createFailed"));
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(t("addRunner.copyFailed"));
    }
  }

  if (!created) {
    return (
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <FormField label={t("addRunner.name")} htmlFor="runner-name" hint={t("addRunner.nameHint")}>
          <Input id="runner-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required autoFocus />
        </FormField>
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" disabled={createRunner.isPending || !name.trim()}>
            {t("addRunner.getCommand")}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t("addRunner.back")}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <Waiting
      runnerId={created.runnerId}
      command={created.installCommand}
      copied={copied}
      error={error}
      onCopy={(command) => void copy(command)}
      onConnected={onConnected}
      onCancel={onCancel}
    />
  );
}

function Waiting(props: {
  runnerId: string;
  command: string;
  copied: boolean;
  error: string | null;
  onCopy: (command: string) => void;
  onConnected: (runnerId: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("harnesses");
  const [nativePlugins, setNativePlugins] = useState(false);
  const command = props.command + (nativePlugins ? " --native-plugins" : "");
  const { data } = useQuery(orpc.runners.list.queryOptions({ refetchInterval: 2000 }));
  const online = data?.some((r) => r.id === props.runnerId && r.status === "online") ?? false;
  const { onConnected, runnerId } = props;
  useEffect(() => {
    if (online) onConnected(runnerId);
  }, [online, onConnected, runnerId]);

  return (
    <div className="space-y-4">
      <p className="text-[14px] text-muted">{t("addRunner.runThis")}</p>
      <label className="flex items-start gap-2 text-[14px]">
        <input type="checkbox" className="mt-1" checked={nativePlugins} onChange={(e) => setNativePlugins(e.target.checked)} />
        <span>{t("addRunner.native")}<span className="block text-[13px] text-muted">{t("addRunner.nativeText")}</span></span>
      </label>
      <div className="relative">
        <pre
          aria-label={t("addRunner.command")}
          className="overflow-x-auto whitespace-pre-wrap break-all rounded-xl border border-line bg-bg p-3.5 pr-12 font-mono text-[12.5px] leading-relaxed"
        >
          {command}
        </pre>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t("addRunner.copy")} className="absolute right-2 top-2" onClick={() => props.onCopy(command)}>
          {props.copied ? <Check /> : <Copy />}
        </Button>
      </div>
      {props.error && (
        <p role="alert" className="text-[13px] text-danger">
          {props.error}
        </p>
      )}
      <p role="status" className="flex items-center gap-2 text-[14px] text-muted">
        <Loader2 size={15} className="animate-spin" aria-hidden />
        {t("addRunner.waiting")}
      </p>
      <Button type="button" variant="ghost" onClick={props.onCancel}>
        {t("addRunner.back")}
      </Button>
    </div>
  );
}
