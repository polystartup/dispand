import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Empty, List } from "../components/settings/parts.tsx";
import { SkillEditor, type SkillPackage } from "../components/settings/SkillEditor.tsx";
import { PageHeader } from "../components/Placeholder.tsx";
import { orpc } from "../lib/api.ts";

export const Route = createFileRoute("/_app/settings/skills")({ component: Skills });

function Skills() {
  const packages = useQuery(orpc.skills.list.queryOptions());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [sheet, setSheet] = useState<{ pkg?: SkillPackage } | null>(null);

  const create = (
    <Button onClick={() => setSheet({})}>
      <Plus /> Create skill
    </Button>
  );
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <PageHeader title="Skills" subtitle="Reusable know-how for your agents." />
        {packages.data && packages.data.length > 0 && create}
      </div>
      {packages.error && !packages.data && (
        <p role="alert" className="text-[14px] text-danger">
          Could not load the skills.
        </p>
      )}
      {packages.data?.length === 0 && (
        <Empty title="No skill yet" text="A skill is instructions, and the files they use, that an agent follows when a task calls for them.">
          {create}
        </Empty>
      )}
      {packages.data && packages.data.length > 0 && (
        <List>
          {packages.data.map((p) => {
            const expanded = open.has(p.packageId);
            return (
              <li key={p.packageId}>
                <div className="flex items-center gap-2 pr-3">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={`skills-${p.packageId}`}
                    onClick={() => toggle(p.packageId)}
                    className="flex min-w-0 flex-1 items-center gap-3 px-5 py-4 text-left transition hover:bg-hover"
                  >
                    <ChevronRight aria-hidden className={cn("size-4 shrink-0 text-faint transition", expanded && "rotate-90")} />
                    <span className="min-w-0">
                      <span className="block truncate text-[15px] font-medium">{p.name}</span>
                      <span className="block truncate text-[13px] text-muted">
                        {p.plugin ? `From plugin ${p.plugin.name} · ` : ""}
                        {p.skills.length === 1 ? p.description : `${p.skills.length} skills`}
                      </span>
                    </span>
                  </button>
                  {p.plugin ? (
                    <span className="shrink-0 text-[12px] text-faint">Read-only</span>
                  ) : (
                    <Button variant="ghost" size="sm" aria-label={`Edit ${p.name}`} onClick={() => setSheet({ pkg: p })}>
                      Edit
                    </Button>
                  )}
                </div>
                {expanded && (
                  <ul id={`skills-${p.packageId}`} className="space-y-2 px-5 pb-4 pl-12">
                    {p.skills.map((s) => (
                      <li key={s.name} className="text-[13px]">
                        <span className="font-mono font-medium">{s.name}</span>
                        <span className="block text-muted">{s.description}</span>
                      </li>
                    ))}
                    {p.requiredTools.length > 0 && (
                      <li className="text-[13px] text-muted">Requires {p.requiredTools.map((t) => t.name).join(", ")}</li>
                    )}
                  </ul>
                )}
              </li>
            );
          })}
        </List>
      )}
      {sheet && <SkillEditor key={sheet.pkg?.packageId ?? "new"} pkg={sheet.pkg} onClose={() => setSheet(null)} />}
    </>
  );
}
