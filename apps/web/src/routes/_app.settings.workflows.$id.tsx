import { tableIdsOf, validateDataSteps, type TableSchema } from "@dispand/domain/workflows/data-steps";
import { deriveExpectedOutputs, validateWorkflow } from "@dispand/domain/workflows/derive";
import { addStep, type AddAt, type StepType, type WorkflowDef } from "@dispand/domain/workflows/model";
import { useMutation, useQueries, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { BannerSlot } from "../components/settings/parts.tsx";
import { Canvas } from "../components/workflow/Canvas.tsx";
import { WorkflowTabs } from "../components/workflow/Runs.tsx";
import { StepPanel } from "../components/workflow/StepPanel.tsx";
import { Autosaver, saverFor, type SaveState } from "../components/workflow/autosave.ts";
import { api, orpc } from "../lib/api.ts";

export const Route = createFileRoute("/_app/settings/workflows/$id")({ component: EditWorkflow });

function EditWorkflow() {
  const { id } = Route.useParams();
  const workflow = useQuery(orpc.workflows.get.queryOptions({ input: { id }, staleTime: Infinity }));
  if (workflow.error) return <p role="alert" className="text-[14px] text-danger">Could not load the workflow.</p>;
  if (!workflow.data) return null;
  return <Editor key={id} workflow={workflow.data} />;
}

type Workflow = Awaited<ReturnType<typeof api.workflows.get>>;

/** The tables loaded so far, and whether every one has answered (found or not). */
function combineTables(results: UseQueryResult<TableSchema>[]) {
  return { tables: results.flatMap((r) => (r.data ? [r.data] : [])), settled: results.every((r) => !r.isPending) };
}
type SaveInput = { id: string; name: string; def: WorkflowDef };

function Editor({ workflow }: { workflow: Workflow }) {
  const [name, setName] = useState(workflow.name);
  const [def, setDef] = useState<WorkflowDef>(workflow.def);
  const [selected, setSelected] = useState<string | null>(workflow.def.trigger.field.id);
  const [state, setState] = useState<SaveState>("saved");
  const agents = useQuery(orpc.agents.list.queryOptions());
  const queryClient = useQueryClient();
  const [edited, setEdited] = useState(false);
  // Once an edit is saved, "Workflow saved" stays through the next autosaves instead of blinking.
  const [savedOnce, setSavedOnce] = useState(false);
  useEffect(() => {
    if (edited && state === "saved") setSavedOnce(true);
  }, [edited, state]);
  const home = useQuery(orpc.pages.home.queryOptions());
  const navigate = useNavigate();
  const onHome = home.data?.widgets.some((w) => w.type === "workflow-form" && w.workflowId === workflow.id) ?? false;
  const addToHome = useMutation(
    orpc.widgets.create.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: orpc.pages.home.key() });
        await navigate({ to: "/" });
      },
    }),
  );
  const [getKey] = useState(() => orpc.workflows.get.queryKey({ input: { id: workflow.id } }));
  // The schedule's state and fires come with the saved workflow; pausing refreshes them.
  const pause = useMutation(
    orpc.workflows.setScheduleEnabled.mutationOptions({ onSuccess: () => queryClient.invalidateQueries({ queryKey: getKey }) }),
  );

  // Autosave: 800 ms after the last change, one save at a time, through one queue per workflow
  // shared by every mount of its editor; what is pending is saved when leaving.
  const [cache] = useState(() => (saved: Workflow) => {
    queryClient.setQueryData(getKey, saved);
    void queryClient.invalidateQueries({ queryKey: orpc.workflows.list.key() });
  });
  const [saver] = useState(() =>
    saverFor(workflow.id, () => new Autosaver<SaveInput, Workflow>((input) => api.workflows.update(input), { state: () => {}, saved: cache })),
  );
  // This editor hears the queue's state while mounted (a save left running by a previous mount included).
  useEffect(() => saver.listen({ state: setState, saved: cache }), [saver, cache]);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setEdited(true);
    const trimmed = name.trim();
    if (trimmed) saver.change({ id: workflow.id, name: trimmed, def });
    else setState("unsaved");
  }, [name, def, workflow.id, saver]);
  const current = useRef({ name, def });
  current.current = { name, def };
  useEffect(
    () => () => {
      // Coming back before the saves land must show these edits, not the cached older version.
      const { name, def } = current.current;
      queryClient.setQueryData(getKey, (old: Workflow | undefined) => old && { ...old, name: name.trim() || old.name, def });
      // Saves still queued go on without this editor; their results keep the cache current.
      saver.listen({ state: () => {}, saved: cache });
      void saver.flush();
    },
    [saver, queryClient, getKey, cache],
  );

  // The tables its data steps use, with their fields: what wiring, descriptions and checks need.
  const tableList = useQuery(orpc.tables.list.queryOptions());
  const tableIds = useMemo(() => tableIdsOf(def), [def]);
  const { tables, settled } = useQueries({
    queries: tableIds.map((tableId) => ({ ...orpc.tables.get.queryOptions({ input: { id: tableId } }), retry: 1 })),
    combine: combineTables,
  });
  const tableNames = useMemo(() => new Map(tableList.data?.map((t) => [t.id, t.name])), [tableList.data]);
  const expected = useMemo(() => deriveExpectedOutputs(def, tables), [def, tables]);
  // A table still loading isn't reported as gone.
  const issues = useMemo(() => [...validateWorkflow(def), ...(settled ? validateDataSteps(def, tables) : [])], [def, tables, settled]);
  const issueCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of issues) counts.set(i.nodeId, (counts.get(i.nodeId) ?? 0) + 1);
    return counts;
  }, [issues]);
  const agentNames = useMemo(() => new Map(agents.data?.map((a) => [a.id, a.name])), [agents.data]);
  const onAdd = useCallback((at: AddAt, type: StepType) => {
    const nodeId = `node_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    setDef((d) => addStep(d, at, nodeId, type));
    setSelected(nodeId);
  }, []);

  const status = { saved: "Saved", unsaved: "Edited", saving: "Saving…", error: "Couldn't save" }[state];

  return (
    <>
      <Link to="/settings/workflows" className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted transition hover:text-fg">
        <ChevronLeft size={15} aria-hidden /> Workflows
      </Link>
      {/* Not role="status" banners: the save state below is the page's one status. */}
      <BannerSlot>
        {onHome && !edited && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-surface px-5 py-4 shadow-card">
            <p className="text-[15px] font-medium">This workflow is on Home.</p>
            <Button asChild variant="outline">
              <Link to="/">Open Home</Link>
            </Button>
          </div>
        )}
        {home.data && !onHome && savedOnce && state !== "error" && issues.length === 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-surface px-5 py-4 shadow-card">
            <p className="text-[15px] font-medium">Workflow saved.</p>
            <Button
              // The widget copies the saved workflow: wait for the edits to land.
              disabled={addToHome.isPending || state !== "saved"}
              onClick={() => {
                if (addToHome.isPending || state !== "saved") return;
                addToHome.mutate({ pageId: home.data.id, type: "workflow-form", workflowId: workflow.id });
              }}
            >
              Add it to Home
            </Button>
          </div>
        )}
      </BannerSlot>
      {addToHome.isError && <p role="alert" className="mb-4 text-[14px] text-danger">Could not add it to Home. Try again.</p>}
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <input
          aria-label="Workflow name"
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
          className="min-w-0 flex-1 rounded-lg bg-transparent text-[28px] font-semibold leading-tight tracking-tight outline-none placeholder:text-faint focus-visible:outline-none"
          placeholder="Name this workflow"
        />
        <span role="status" className={state === "error" ? "text-[13px] text-danger" : "text-[13px] text-muted"}>
          {status}
          {issues.length > 0 && state !== "error" && ` · ${issues.length} issue${issues.length > 1 ? "s" : ""} to fix before it can run`}
        </span>
      </header>
      <WorkflowTabs id={workflow.id} />
      {agents.error && !agents.data && (
        <p role="alert" className="mb-4 text-[14px] text-danger">
          Could not load the agents: steps can't be given one until the page is reloaded.
        </p>
      )}
      <div className="overflow-hidden rounded-2xl bg-surface/60 shadow-card ring-1 ring-line md:flex md:h-[640px]">
        <div className="h-[420px] md:h-full md:min-w-0 md:flex-1">
          <Canvas
            def={def}
            agentNames={agentNames}
            tableNames={tableNames}
            selectedId={selected}
            issueCounts={issueCounts}
            onSelect={setSelected}
            onAdd={onAdd}
            onChange={setDef}
          />
        </div>
        {selected && (
          <aside aria-label="Step settings" className="border-t border-line bg-surface p-5 md:w-[340px] md:shrink-0 md:overflow-y-auto md:border-t-0 md:border-l">
            <StepPanel
              key={selected}
              def={def}
              nodeId={selected}
              agents={agents.data ?? []}
              expected={expected}
              issues={issues}
              schedule={workflow.schedule}
              fires={workflow.fires}
              onPause={(enabled) => pause.mutate({ id: workflow.id, enabled })}
              tables={tables}
              tableList={tableList.data ?? []}
              onChange={setDef}
              onClose={() => setSelected(null)}
            />
          </aside>
        )}
      </div>
    </>
  );
}
