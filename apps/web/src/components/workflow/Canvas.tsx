import "@xyflow/react/dist/style.css";
import {
  Background,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import { Bot, CircleAlert, Clock, Database, GitBranch, MessageCircle, MousePointerClick, Repeat, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { connect, disconnect, loopOf, nodesOf, type AddAt, type ConditionStep, type DataStep, type Edge as WorkflowEdge, type LoopStep, type StepType, type WorkflowDef } from "@dispand/domain/workflows/model";
import { describeSchedule } from "@dispand/domain/workflows/schedule";
import { cn } from "@/lib/utils";
import { AddStepMenu } from "./AddStepMenu.tsx";
import { CARD, GROUP, layoutWorkflow } from "./layout.ts";
import { describeCondition } from "./panels/ConditionPanel.tsx";
import { describeDataStep } from "./panels/DataPanel.tsx";

type CardData = {
  title: string;
  subtitle: string;
  kind: "button" | "chat" | "schedule" | "agent" | "condition" | "data";
  selected: boolean;
  issues: number;
  /** In a loop's body: its "+" doesn't offer "For each". */
  inLoop: boolean;
  /** Adds a step after this node: on `branch` for a condition. */
  onAdd: (type: StepType, branch?: Branch) => void;
};
/** A loop: its box around the body, the title above it and the "+" that adds the body's first step. */
type GroupData = { name: string; title: string; subtitle: string; empty: boolean; selected: boolean; issues: number; onAdd: (type: StepType) => void; onAddInside: (type: StepType) => void };
type Branch = NonNullable<WorkflowEdge["branch"]>;
type LinkData = { fromName: string; toName: string; branch?: Branch; inLoop: boolean; onAdd: (type: StepType) => void; onRemove: () => void };

const icons = { button: MousePointerClick, chat: MessageCircle, schedule: Clock, agent: Bot, condition: GitBranch, data: Database };
const branchLabels: Record<Branch, string> = { then: "Then", else: "Else" };
/** Where a condition's Then and Else leave its card. */
const branchAt: Record<Branch, string> = { then: "25%", else: "75%" };
const handle = "!size-2.5 !border-0 !bg-faint";

function Card({ data }: NodeProps<Node<CardData>>) {
  const Icon = icons[data.kind];
  const title = data.title || "Untitled";
  return (
    <div
      className={cn(
        "relative flex h-16 w-64 items-center gap-3 rounded-2xl bg-surface px-4 shadow-card ring-1 ring-line transition",
        data.selected && "ring-2 ring-accent",
      )}
    >
      {/* Nothing runs before the trigger: it takes no link. */}
      {(data.kind === "agent" || data.kind === "condition" || data.kind === "data") && <Handle type="target" position={Position.Top} className={handle} />}
      <span className={cn("grid size-9 shrink-0 place-items-center rounded-xl", data.kind === "button" || data.kind === "chat" || data.kind === "schedule" ? "bg-active text-fg" : "bg-accent/10 text-accent")}>
        <Icon size={18} aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium">{title}</span>
        <span className="block truncate text-[12px] text-muted">{data.subtitle}</span>
      </span>
      {data.issues > 0 && (
        <span className="text-danger" title={`${data.issues} issue${data.issues > 1 ? "s" : ""}`}>
          <CircleAlert size={16} aria-label={`${data.issues} issue${data.issues > 1 ? "s" : ""}`} />
        </span>
      )}
      {data.kind === "condition" ? (
        // Its links out leave from the handle of their branch, each with its own "+".
        (["then", "else"] as const).map((branch) => (
          <span key={branch}>
            <Handle id={branch} type="source" position={Position.Bottom} className={handle} style={{ left: branchAt[branch] }} />
            <span className="absolute top-full mt-1 flex -translate-x-1/2 items-center gap-1" style={{ left: branchAt[branch] }}>
              <AddStepMenu onPick={(type) => data.onAdd(type, branch)} label={`Add a step on ${title}'s ${branchLabels[branch]} branch`} className="size-5" inLoop={data.inLoop} />
              <span className="text-[11px] font-medium text-muted">{branchLabels[branch]}</span>
            </span>
          </span>
        ))
      ) : (
        <>
          <Handle type="source" position={Position.Bottom} className={handle} />
          <AddStepMenu onPick={(type) => data.onAdd(type)} label={`Add a step after ${title}`} className="absolute top-full left-1/2 mt-1 size-5 -translate-x-1/2" inLoop={data.inLoop} />
        </>
      )}
    </div>
  );
}

function Group({ data }: NodeProps<Node<GroupData>>) {
  const issues = `${data.issues} issue${data.issues > 1 ? "s" : ""}`;
  return (
    <div className={cn("relative size-full rounded-3xl border-2 border-dashed bg-hover/50 transition", data.selected ? "border-accent" : "border-line")}>
      <Handle type="target" position={Position.Top} className={handle} />
      <div className="flex items-center gap-2 px-4 pt-3 text-[13px]">
        <span className="grid size-6 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent">
          <Repeat size={14} aria-hidden />
        </span>
        <span className="min-w-0 truncate font-medium">{data.title}</span>
        <span className="shrink-0 text-muted">{data.subtitle}</span>
        {data.issues > 0 && <CircleAlert size={16} className="ml-auto shrink-0 text-danger" aria-label={issues} />}
      </div>
      {data.empty && (
        <div className="absolute inset-x-0 flex flex-col items-center gap-1" style={{ top: GROUP.header + 8 }}>
          <AddStepMenu onPick={data.onAddInside} label={`Add a step inside ${data.name}`} className="size-5" inLoop />
          <span className="text-[11px] text-muted">Steps to repeat go here</span>
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className={handle} />
      <AddStepMenu onPick={data.onAdd} label={`Add a step after ${data.name}`} className="absolute top-full left-1/2 mt-1 size-5 -translate-x-1/2" />
    </div>
  );
}

/** A link, with a "+" at its middle to add a step on it and, once selected, a "×" to remove it. */
function Link({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, data, markerEnd }: EdgeProps<Edge<LinkData>>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={selected ? { stroke: "var(--accent)", strokeWidth: 2 } : undefined} />
      {data && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan absolute flex items-center gap-1"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {data.branch && (
              <span className="rounded-full bg-surface px-1.5 text-[11px] font-medium text-muted ring-1 ring-line">{branchLabels[data.branch]}</span>
            )}
            <AddStepMenu onPick={data.onAdd} label={`Add a step between ${data.fromName} and ${data.toName}`} className="size-5" inLoop={data.inLoop} />
            {selected && (
              <button
                type="button"
                onClick={data.onRemove}
                aria-label={`Remove the link from ${data.fromName} to ${data.toName}`}
                className="pointer-events-auto absolute left-full ml-1 grid size-5 place-items-center rounded-full bg-surface text-danger shadow-card ring-1 ring-line transition hover:bg-hover"
              >
                <X size={12} aria-hidden />
              </button>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

// Not "group": React Flow styles that name itself.
const nodeTypes = { card: Card, loop: Group };
const edgeTypes = { link: Link };
const edgeId = (e: { from: string; to: string }) => `${e.from}->${e.to}`;

/**
 * The workflow as a graph, laid out top to bottom: "+" under every card and on every link adds a
 * step there; dragging from a card's bottom handle to another's top links them.
 */
export function Canvas({
  def,
  agentNames,
  tableNames,
  selectedId,
  issueCounts,
  onSelect,
  onAdd,
  onChange,
}: {
  def: WorkflowDef;
  agentNames: Map<string, string>;
  tableNames: Map<string, string>;
  selectedId: string | null;
  issueCounts: Map<string, number>;
  onSelect: (nodeId: string) => void;
  onAdd: (at: AddAt, type: StepType) => void;
  onChange: (def: WorkflowDef) => void;
}) {
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  useEffect(() => {
    if (!refusal) return;
    const timer = setTimeout(() => setRefusal(null), 4000);
    return () => clearTimeout(timer);
  }, [refusal]);

  const { nodes, edges } = useMemo(() => {
    const list = nodesOf(def);
    const names = new Map(list.map((n) => [n.id, n.name || "Untitled"]));
    const trigger = def.trigger.field;
    const layout = layoutWorkflow(def);
    const condition = (id: string) => def.steps.find((s): s is ConditionStep => s.id === id && s.type === "condition");
    const dataStep = (id: string) => def.steps.find((s): s is DataStep => s.id === id && s.type === "data");
    const loop = (id: string) => def.steps.find((s): s is LoopStep => s.id === id && s.type === "loop");
    const listName = (step: LoopStep) => {
      const source = step.list && list.find((n) => n.id === step.list!.nodeId);
      return source && step.list ? `${source.key}.${step.list.name}` : null;
    };
    // The nodes' sizes are known (fixed cards, the loop's box from the layout): saying so, with
    // `measured`, keeps them visible and their handles measured through every edit. Without it each
    // new node object is unmeasured until the ResizeObserver reports again, and may stay hidden.
    const known = (box: { w: number; h: number }) => ({ width: box.w, height: box.h, measured: { width: box.w, height: box.h } });
    // A loop's box comes before its body's cards: React Flow wants parents first.
    const nodes: Node<CardData | GroupData>[] = [...list]
      .sort((a, b) => Number(b.type === "loop") - Number(a.type === "loop"))
      .map((n): Node<CardData | GroupData> => {
        const step = loop(n.id);
        const box = layout.groups[n.id];
        if (step && box) {
          const data: GroupData = {
            name: n.name || "Untitled",
            title: `For each ${listName(step) ?? "…"}`,
            subtitle: `at most ${step.maxIterations}`,
            empty: !def.steps.some((s) => s.loopId === n.id),
            selected: n.id === selectedId,
            issues: issueCounts.get(n.id) ?? 0,
            onAdd: (type) => onAdd({ after: n.id }, type),
            onAddInside: (type) => onAdd({ loop: n.id }, type),
          };
          return { id: n.id, type: "loop", position: layout.nodes[n.id]!, deletable: false, ...known(box), data };
        }
        const parent = n.loopId === undefined ? undefined : layout.groups[n.loopId];
        const at = layout.nodes[n.id]!;
        return {
          id: n.id,
          type: "card",
          // A body card sits relative to its loop's box and can't leave it.
          position: parent ? { x: at.x - parent.x, y: at.y - parent.y } : at,
          ...(parent ? { parentId: n.loopId, extent: "parent" as const } : {}),
          deletable: false,
          ...known(CARD),
          data: {
            title: n.name,
            subtitle:
              n.kind === "trigger"
                ? trigger.type === "chat"
                  ? `Chat · ${agentNames.get(trigger.agentId) ?? "no agent"}`
                  : trigger.type === "schedule"
                    ? describeSchedule(trigger.cron, trigger.timezone)
                    : "Button"
                : condition(n.id)
                  ? describeCondition(def, condition(n.id)!)
                  : dataStep(n.id)
                    ? describeDataStep(dataStep(n.id)!, tableNames)
                    : (agentNames.get(n.agentId ?? "") ?? "Choose an agent"),
            kind: n.kind === "trigger" ? trigger.type : n.type === "condition" || n.type === "data" ? n.type : "agent",
            selected: n.id === selectedId,
            issues: issueCounts.get(n.id) ?? 0,
            inLoop: n.loopId !== undefined,
            onAdd: (type, branch) => onAdd({ after: n.id, ...(branch ? { branch } : {}) }, type),
          },
        };
      });
    const edges: Edge<LinkData>[] = def.edges.map((e) => ({
      id: edgeId(e),
      type: "link",
      source: e.from,
      target: e.to,
      ...(e.branch ? { sourceHandle: e.branch } : {}),
      selected: edgeId(e) === selectedEdge,
      data: {
        fromName: names.get(e.from) ?? "",
        toName: names.get(e.to) ?? "",
        ...(e.branch ? { branch: e.branch } : {}),
        inLoop: loopOf(def, e.from) !== undefined,
        onAdd: (type) => onAdd({ edge: { from: e.from, to: e.to } }, type),
        onRemove: () => onChange(disconnect(def, e)),
      },
    }));
    return { nodes, edges };
  }, [def, agentNames, tableNames, selectedId, issueCounts, onAdd, onChange, selectedEdge]);

  // Fit the view when the graph's shape changes, not on every edit of a step.
  const shape = `${nodes.map((n) => n.id).join()}|${edges.map((e) => e.id).join()}`;
  const flow = useRef<ReactFlowInstance<Node<CardData | GroupData>, Edge<LinkData>> | null>(null);
  useEffect(() => {
    void flow.current?.fitView({ maxZoom: 1, padding: 0.3 });
  }, [shape]);

  return (
    <div className="relative h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onInit={(instance) => {
          flow.current = instance;
        }}
        onNodeClick={(_, node) => {
          setSelectedEdge(null);
          onSelect(node.id);
        }}
        onEdgeClick={(_, edge) => setSelectedEdge(edge.id)}
        onPaneClick={() => setSelectedEdge(null)}
        onEdgesDelete={(deleted) => {
          onChange(deleted.reduce((d, e) => disconnect(d, { from: e.source, to: e.target }), def));
          setSelectedEdge(null);
        }}
        onConnect={({ source, target, sourceHandle }) => {
          // A condition's links start from its Then or Else handle.
          const branch = sourceHandle === "then" || sourceHandle === "else" ? sourceHandle : undefined;
          const result = connect(def, source, target, branch);
          if ("refused" in result) setRefusal(result.refused);
          else onChange(result.def);
        }}
        nodesDraggable={false}
        fitView
        fitViewOptions={{ maxZoom: 1, padding: 0.3 }}
        minZoom={0.4}
        maxZoom={1.5}
        aria-label="Workflow canvas"
      >
        <Background gap={20} size={1} color="var(--line)" />
      </ReactFlow>
      {refusal && (
        <p role="alert" className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-xl bg-fg px-4 py-2 text-[13px] text-bg shadow-pop">
          {refusal}
        </p>
      )}
    </div>
  );
}
