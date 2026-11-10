import dagre from "@dagrejs/dagre";
import { nodesOf, type Edge, type WorkflowDef } from "@dispand/domain/workflows/model";

/** A card's size on the canvas. */
export const CARD = { w: 256, h: 64 };
/** A loop's box around its body: the room kept around the cards, and the title above them. */
export const GROUP = { pad: 24, header: 56, footer: 40, emptyH: 96 };

type Box = { x: number; y: number; w: number; h: number };

export type Layout = {
  /** Each node's box, by its top-left corner on the canvas (body cards too). */
  nodes: Record<string, { x: number; y: number }>;
  /** Each loop's box around its body. */
  groups: Record<string, Box>;
};

/**
 * Where the nodes of one scope go, top to bottom, every node below all the nodes it waits for:
 * their top-left corners, and the size of everything.
 */
function place(sizes: Map<string, { w: number; h: number }>, edges: Edge[]) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", ranksep: 72, nodesep: 40 });
  g.setDefaultEdgeLabel(() => ({}));
  // A condition's Then branch on the left, Else on the right: dagre orders siblings from the order
  // it is given, here Else targets after the rest and Else links before Then ones (layout.test.ts).
  const elseTargets = new Set(edges.filter((e) => e.branch === "else").map((e) => e.to));
  for (const id of [...sizes.keys()].sort((a, b) => Number(elseTargets.has(a)) - Number(elseTargets.has(b)))) {
    const { w, h } = sizes.get(id)!;
    g.setNode(id, { width: w, height: h });
  }
  for (const e of [...edges].sort((a, b) => Number(a.branch !== "else") - Number(b.branch !== "else"))) {
    if (g.hasNode(e.from) && g.hasNode(e.to)) g.setEdge(e.from, e.to);
  }
  dagre.layout(g);
  const at = new Map<string, { x: number; y: number }>();
  for (const [id, { w, h }] of sizes) {
    const n = g.node(id);
    at.set(id, { x: n.x - w / 2, y: n.y - h / 2 });
  }
  const { width = 0, height = 0 } = g.graph();
  return { at, w: width, h: height };
}

/**
 * Where each card goes. A loop is laid out as one node as big as its body, which is laid out on
 * its own first (dagre can't link to a group): the body inside the group's box, under its title.
 */
export function layoutWorkflow(def: WorkflowDef): Layout {
  const nodes = nodesOf(def);
  const groups: Layout["groups"] = {};
  const bodies = new Map<string, ReturnType<typeof place>>();
  const sizes = new Map<string, { w: number; h: number }>();
  for (const n of nodes) {
    if (n.loopId !== undefined) continue;
    if (n.type !== "loop") {
      sizes.set(n.id, CARD);
      continue;
    }
    const body = nodes.filter((b) => b.loopId === n.id);
    const inside = place(new Map(body.map((b) => [b.id, CARD])), def.edges);
    bodies.set(n.id, inside);
    sizes.set(n.id, {
      w: body.length === 0 ? CARD.w + 2 * GROUP.pad : inside.w + 2 * GROUP.pad,
      h: body.length === 0 ? GROUP.emptyH : GROUP.header + inside.h + GROUP.footer,
    });
  }
  const top = place(sizes, def.edges);
  const out: Layout["nodes"] = {};
  for (const [id, at] of top.at) {
    out[id] = at;
    const body = bodies.get(id);
    if (!body) continue;
    const { w, h } = sizes.get(id)!;
    groups[id] = { ...at, w, h };
    for (const [bodyId, inner] of body.at) {
      out[bodyId] = { x: at.x + GROUP.pad + inner.x, y: at.y + GROUP.header + inner.y };
    }
  }
  return { nodes: out, groups };
}
