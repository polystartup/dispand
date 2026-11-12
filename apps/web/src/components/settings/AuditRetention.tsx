import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { orpc } from "../../lib/api.ts";

/**
 * How many days Audit keeps its rows (design 6.8); older ones are deleted each hour. Yours
 * only: no agent reads or changes it.
 */
export function AuditRetention() {
  const queryClient = useQueryClient();
  const current = useQuery(orpc.workspace.auditRetention.queryOptions());
  // What is typed, while editing; otherwise the field follows the setting (another tab).
  const [typed, setTyped] = useState<string | null>(null);
  const save = useMutation(orpc.workspace.setAuditRetention.mutationOptions({ onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.workspace.auditRetention.key() }) }));
  if (!current.data) return null;
  const value = typed ?? String(current.data.days);
  const n = Number(value);
  const valid = Number.isInteger(n) && n >= 1 && n <= 3650;
  return (
    <form
      aria-label="Audit retention"
      className="mb-6 flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) save.mutate({ days: n }, { onSuccess: () => setTyped(null) });
      }}
    >
      <label htmlFor="audit-retention-days" className="text-[13px] text-muted">
        Keep Audit for
      </label>
      <Input id="audit-retention-days" type="number" min={1} max={3650} value={value} onChange={(e) => setTyped(e.target.value)} aria-invalid={!valid} className="w-24" />
      <span className="text-[13px] text-muted">days</span>
      <Button type="submit" variant="outline" disabled={!valid || n === current.data.days || save.isPending}>
        Save
      </Button>
      {!valid && (
        <p role="alert" className="w-full text-[13px] text-danger">
          A whole number from 1 to 3,650
        </p>
      )}
      {save.error && (
        <p role="alert" className="w-full text-[13px] text-danger">
          {save.error.message}
        </p>
      )}
    </form>
  );
}
