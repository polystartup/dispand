import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import type { api } from "../../lib/api.ts";
import { orpc } from "../../lib/api.ts";
import { selectClass } from "../data/NewFieldPopover.tsx";
import { Empty, FormField, List } from "../settings/parts.tsx";

export type MemoryScope = { scope: "workspace" } | { scope: "table"; tableId: string } | { scope: "agent"; agentId: string };
type Listed = Awaited<ReturnType<typeof api.memories.list>>;
type Entry = Listed["entries"][number];

const TYPES = [
  ["business", "How the business works"],
  ["practice", "How work is done"],
  ["fact", "Facts"],
  ["reference", "Where things are"],
] as const;

/** Who wrote the entry's current revision, and when. */
function byline(e: Pick<Entry, "author" | "updatedAt">): string {
  const who = e.author.type === "user" ? "You" : (e.author.name ?? "A deleted agent");
  return `${who} · ${new Date(e.updatedAt).toLocaleString()}`;
}

/** Why the procedure refused, when it says; else a generic line. */
function reason(e: unknown, fallback: string): string {
  if (typeof e === "object" && e !== null && "code" in e) {
    const { code, message } = e as { code: unknown; message?: unknown };
    if (code === "BAD_REQUEST" && typeof message === "string" && !message.startsWith("Input validation")) return message;
  }
  return fallback;
}

/**
 * A memory (design 6.5): its entries grouped by type as the index groups them, each opening in
 * a sheet with its frontmatter, body, author and time; Add, Edit and Remove; Accept and Revert
 * for an agent's entry; the removed ones with Restore.
 */
export function MemoryPanel({ where }: { where: MemoryScope }) {
  const listed = useQuery(orpc.memories.list.queryOptions({ input: where }));
  // An entry's id, "new" to add one, or null.
  const [open, setOpen] = useState<string | null>(null);
  const add = (
    <Button onClick={() => setOpen("new")}>
      <Plus /> Add entry
    </Button>
  );
  const data = listed.data;
  const entry = data && open !== "new" ? [...data.entries, ...data.removed].find((e) => e.id === open) : undefined;
  return (
    <>
      {listed.error && !data && (
        <p role="alert" className="text-[14px] text-danger">
          Could not load the memory.
        </p>
      )}
      {data?.entries.length === 0 && (
        <Empty title="Nothing kept yet" text="Each entry is one fact agents read at the start of their Jobs: how the business works, how work is done, where things are.">
          {add}
        </Empty>
      )}
      {data && data.entries.length > 0 && (
        <>
          <div className="mb-3 flex justify-end">{add}</div>
          {TYPES.map(([type, label]) => {
            const group = data.entries.filter((e) => e.type === type);
            if (group.length === 0) return null;
            return (
              <section key={type} aria-label={label} className="mb-6">
                <h2 className="mb-2 px-1 text-[13px] font-medium text-muted">{label}</h2>
                <List>
                  {group.map((e) => (
                    <EntryRow key={e.id} entry={e} onOpen={() => setOpen(e.id)} />
                  ))}
                </List>
              </section>
            );
          })}
        </>
      )}
      {data && data.removed.length > 0 && (
        <section aria-label="Removed" className="mb-6">
          <h2 className="mb-2 px-1 text-[13px] font-medium text-muted">Removed</h2>
          <List>
            {data.removed.map((e) => (
              <EntryRow key={e.id} entry={e} onOpen={() => setOpen(e.id)} />
            ))}
          </List>
        </section>
      )}
      {open && (open === "new" || entry) && <EntrySheet key={open} where={where} entry={entry} onClose={() => setOpen(null)} />}
    </>
  );
}

function EntryRow({ entry, onOpen }: { entry: Entry; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} className="block w-full px-5 py-3 text-left transition hover:bg-hover">
        <span className="block truncate text-[15px] font-medium">{entry.name}</span>
        <span className="block truncate text-[13px] text-muted">{entry.description}</span>
        <span className="block truncate text-[12px] text-faint">
          <span className="font-mono">{entry.path}</span> · {byline(entry)}
        </span>
      </button>
    </li>
  );
}

/** One entry: read, then edited in place; or a new one. Mount it only while open. */
function EntrySheet({ where, entry, onClose }: { where: MemoryScope; entry?: Entry; onClose: () => void }) {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: orpc.memories.key() });
  const write = useMutation(orpc.memories.write.mutationOptions({ onSuccess: invalidate }));
  const remove = useMutation(orpc.memories.remove.mutationOptions({ onSuccess: invalidate }));
  const accept = useMutation(orpc.memories.accept.mutationOptions({ onSuccess: invalidate }));
  const revert = useMutation(orpc.memories.revert.mutationOptions({ onSuccess: invalidate }));
  const restore = useMutation(orpc.memories.restore.mutationOptions({ onSuccess: invalidate }));
  const [editing, setEditing] = useState(!entry);
  const [path, setPath] = useState(entry?.path ?? "");
  const [name, setName] = useState(entry?.name ?? "");
  const [description, setDescription] = useState(entry?.description ?? "");
  const [type, setType] = useState<string>(entry?.type ?? "fact");
  const [body, setBody] = useState(entry?.body ?? "");
  const [error, setError] = useState<string | null>(null);
  const busy = write.isPending || remove.isPending || accept.isPending || revert.isPending || restore.isPending;

  async function run(action: () => Promise<unknown>, fallback: string, close = true) {
    setError(null);
    try {
      await action();
      if (close) onClose();
    } catch (e) {
      setError(reason(e, fallback));
    }
  }

  const agentEntry = entry?.author.type === "agent" && !entry.removedAt;
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto bg-surface sm:max-w-lg">
        <SheetHeader className="px-6 pt-6">
          <SheetTitle className="text-[20px] tracking-tight">{entry ? entry.name : "Add entry"}</SheetTitle>
          <SheetDescription>{entry ? byline(entry) : "One fact agents read at the start of their Jobs."}</SheetDescription>
        </SheetHeader>
        <div className="space-y-5 px-6 pb-6">
          {editing ? (
            <form
              className="space-y-5"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => write.mutateAsync({ where, entry: { path, name, description, type, body } }), "Could not save the entry.");
              }}
            >
              <FormField label="Path" htmlFor="memory-path" hint="A file name ending in .md, in folders if you like: clients/acme.md.">
                <Input id="memory-path" value={path} onChange={(e) => setPath(e.target.value)} readOnly={!!entry} required />
              </FormField>
              <FormField label="Name" htmlFor="memory-name">
                <Input id="memory-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required />
              </FormField>
              <FormField label="Description" htmlFor="memory-description" hint="One line: what the entry tells, so an agent knows when to read it.">
                <Input id="memory-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={150} required />
              </FormField>
              <FormField label="Type" htmlFor="memory-type">
                <select id="memory-type" className={selectClass} value={type} onChange={(e) => setType(e.target.value)}>
                  {TYPES.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label="Body" htmlFor="memory-body">
                <Textarea id="memory-body" value={body} onChange={(e) => setBody(e.target.value)} maxLength={8000} rows={10} />
              </FormField>
              <div className="flex gap-2">
                <Button type="submit" disabled={busy}>
                  Save
                </Button>
                <Button type="button" variant="ghost" onClick={() => (entry ? setEditing(false) : onClose())}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            entry && (
              <>
                <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[13px]">
                  <dt className="text-muted">Path</dt>
                  <dd className="font-mono">{entry.path}</dd>
                  <dt className="text-muted">Description</dt>
                  <dd>{entry.description}</dd>
                  <dt className="text-muted">Type</dt>
                  <dd>{TYPES.find(([t]) => t === entry.type)?.[1]}</dd>
                </dl>
                <pre className="whitespace-pre-wrap break-words rounded-lg border border-line bg-bg p-3 text-[13px]">{entry.body}</pre>
                {agentEntry && !entry.acceptedAt && <p className="text-[13px] text-muted">Accepting lets this entry instruct agents that configure the workspace.</p>}
                <div className="flex flex-wrap gap-2">
                  {entry.removedAt ? (
                    <Button disabled={busy} onClick={() => void run(() => restore.mutateAsync({ id: entry.id }), "Could not restore the entry.")}>
                      Restore
                    </Button>
                  ) : (
                    <>
                      <Button variant="outline" onClick={() => setEditing(true)}>
                        Edit
                      </Button>
                      {agentEntry && !entry.acceptedAt && (
                        <Button variant="outline" disabled={busy} onClick={() => void run(() => accept.mutateAsync({ id: entry.id }), "Could not accept the entry.")}>
                          Accept
                        </Button>
                      )}
                      {agentEntry && (
                        <Button variant="outline" disabled={busy} onClick={() => void run(() => revert.mutateAsync({ id: entry.id }), "Could not revert the entry.")}>
                          Revert
                        </Button>
                      )}
                      <Button variant="ghost" disabled={busy} onClick={() => void run(() => remove.mutateAsync({ id: entry.id }), "Could not remove the entry.")}>
                        Remove
                      </Button>
                    </>
                  )}
                </div>
              </>
            )
          )}
          {error && (
            <p role="alert" className="text-[13px] text-danger">
              {error}
            </p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
