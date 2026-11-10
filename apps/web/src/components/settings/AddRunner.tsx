import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { orpc } from "../../lib/api.ts";
import { FormField } from "./parts.tsx";

/**
 * Creates a runner, shows the install command with its single-use code, and waits for the
 * runner to come online. The wait polls `runners.list` every 2 s.
 */
export function AddRunner({ onConnected, onCancel }: { onConnected: (runnerId: string) => void; onCancel: () => void }) {
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
      setError("Could not create the runner. Check the name and try again.");
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy. Select the command and copy it by hand.");
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
        <FormField label="Runner name" htmlFor="runner-name" hint="The machine that will run Claude Code, for example its host name.">
          <Input id="runner-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required autoFocus />
        </FormField>
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" disabled={createRunner.isPending || !name.trim()}>
            Get the install command
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Back
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
      onCopy={() => void copy(created.installCommand)}
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
  onCopy: () => void;
  onConnected: (runnerId: string) => void;
  onCancel: () => void;
}) {
  const { data } = useQuery(orpc.runners.list.queryOptions({ refetchInterval: 2000 }));
  const online = data?.some((r) => r.id === props.runnerId && r.status === "online") ?? false;
  const { onConnected, runnerId } = props;
  useEffect(() => {
    if (online) onConnected(runnerId);
  }, [online, onConnected, runnerId]);

  return (
    <div className="space-y-4">
      <p className="text-[14px] text-muted">Run this on the machine. The code works once and expires in 15 minutes.</p>
      <div className="relative">
        <pre
          aria-label="Install command"
          className="overflow-x-auto whitespace-pre-wrap break-all rounded-xl border border-line bg-bg p-3.5 pr-12 font-mono text-[12.5px] leading-relaxed"
        >
          {props.command}
        </pre>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Copy command" className="absolute right-2 top-2" onClick={props.onCopy}>
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
        Waiting for the runner to come online…
      </p>
      <Button type="button" variant="ghost" onClick={props.onCancel}>
        Back
      </Button>
    </div>
  );
}
