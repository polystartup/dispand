import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { orpc } from "../../lib/api.ts";
import { List } from "./parts.tsx";

type Limit = { id: string; name: string; maxWorking: number; working: number; queued: number };

/** One harness's limit: what works and waits now, and the limit, changed in place. */
function LimitRow({ limit }: { limit: Limit }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(String(limit.maxWorking));
  const [editing, setEditing] = useState(false);
  // Changed elsewhere (another tab, an approved proposal): the field follows unless it is being edited.
  useEffect(() => {
    if (!editing) setValue(String(limit.maxWorking));
  }, [limit.maxWorking, editing]);
  const save = useMutation(orpc.harnesses.setLimit.mutationOptions({ onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.harnesses.limits.key() }) }));
  const n = Number(value);
  const valid = Number.isInteger(n) && n >= 1 && n <= 100;
  const inputId = `limit-${limit.id}`;
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
      <span className="min-w-0">
        <span className="block truncate text-[15px] font-medium">{limit.name}</span>
        <span className="block text-[13px] text-muted">
          {limit.working} working · {limit.queued} waiting
        </span>
      </span>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate({ id: limit.id, maxWorking: n }, { onSuccess: () => setEditing(false) });
        }}
      >
        <label htmlFor={inputId} className="text-[13px] text-muted">
          At most at once
        </label>
        <Input id={inputId} type="number" min={1} max={100} value={value} onChange={(e) => {
            setEditing(true);
            setValue(e.target.value);
          }} aria-invalid={!valid} className="w-20" />
        <Button type="submit" variant="outline" disabled={!valid || n === limit.maxWorking || save.isPending}>
          Save
        </Button>
      </form>
      {!valid && (
        <p role="alert" className="w-full text-[13px] text-danger">
          A whole number from 1 to 100
        </p>
      )}
      {save.error && (
        <p role="alert" className="w-full text-[13px] text-danger">
          {save.error.message}
        </p>
      )}
    </li>
  );
}

/**
 * How many sessions of each harness may work on a turn at once (design 6.1): set it from what the
 * subscription or key behind the harness allows. Past it, Jobs wait their turn, never dropped.
 */
export function HarnessLimits() {
  const limits = useQuery(orpc.harnesses.limits.queryOptions({ refetchInterval: 5000 }));
  if (!limits.data?.length) return null;
  return (
    <section aria-labelledby="harness-limits" className="mt-8">
      <h2 id="harness-limits" className="text-[17px] font-medium tracking-tight">
        Sessions at once
      </h2>
      <p className="mb-3 text-[13px] text-muted">How many of each harness's sessions may work at the same time. Past it, Jobs wait their turn; none is dropped. Raising it lets agents spend more.</p>
      <List>
        {limits.data.map((l) => (
          <LimitRow key={l.id} limit={l} />
        ))}
      </List>
    </section>
  );
}
