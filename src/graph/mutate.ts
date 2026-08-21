import { z } from "zod";
import type { AtlasGraph, AtlasNode, Edge } from "../schema/atlas";
import { ExitCheck, Pitfall, UnitKind } from "../schema/atlas";

/**
 * Graph mutation: the patch vocabulary, and the pure function that applies one.
 *
 * The model never returns a whole graph after the initial draw — only a patch from this closed
 * list, validated before it is applied. That is the single rule keeping a bad generation from
 * silently destroying weeks of progress: the worst a rejected patch can do is nothing.
 *
 * Everything here is pure. `applyPatch` takes a graph and returns a new one; persistence,
 * validation and error reporting all happen at the call site, so this file can be tested without
 * a browser, a network, or a store.
 */

const DraftUnit = z.object({
  kind: UnitKind,
  title: z.string().min(3),
  why: z.string().min(10),
  estimate_min: z.number().int().positive().max(600),
  exit_check: ExitCheck,
  known_pitfalls: z.array(Pitfall).default([]),
});

const DraftRecovery = z.object({
  title: z.string().min(3),
  why: z.string().min(10),
  estimate_min: z.number().int().positive().max(600),
  diagnosis: z.string().min(10),
  remediation: z.array(z.string().min(3)).min(1),
  exit_check: ExitCheck.optional(),
});

export const Patch = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("edit_node"),
    target: z.string().min(1),
    title: z.string().min(3).optional(),
    why: z.string().min(10).optional(),
    estimate_min: z.number().int().positive().max(600).optional(),
    reason: z.string().min(5),
  }),
  z.object({
    op: z.literal("rewrite_check"),
    target: z.string().min(1),
    exit_check: ExitCheck,
    reason: z.string().min(5),
  }),
  z.object({
    op: z.literal("insert_prereq"),
    target: z.string().min(1),
    node: DraftUnit,
    reason: z.string().min(5),
  }),
  z.object({
    op: z.literal("insert_recovery"),
    target: z.string().min(1),
    node: DraftRecovery,
    reason: z.string().min(5),
  }),
  z.object({
    op: z.literal("insert_unit"),
    /** Optional existing node this one should follow. Omitted means it starts a new root. */
    after: z.string().min(1).nullable().default(null),
    node: DraftUnit,
    reason: z.string().min(5),
  }),
  z.object({
    op: z.literal("prune_node"),
    target: z.string().min(1),
    reason: z.string().min(5),
  }),
  z.object({
    op: z.literal("retitle_chapters"),
    chapters: z.array(z.string().min(2)).min(1).max(8),
    reason: z.string().min(5),
  }),
]);

export type Patch = z.infer<typeof Patch>;

/** Stable-ish id from a title, with a suffix so re-adding the same title cannot collide. */
export function nodeId(title: string, prefix = "n"): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 28);
  return `${prefix}_${slug || "node"}_${Date.now().toString(36).slice(-4)}`;
}

/**
 * Re-derive lock/ready after the shape changes.
 *
 * Only touches nodes that have not been engaged with: anything passed, failed, in progress,
 * skipped or pruned keeps its status, because those record what the learner actually did and are
 * not the graph's to overwrite. A fresh node is ready exactly when every prerequisite has passed.
 */
export function recomputeStatuses(graph: AtlasGraph): AtlasGraph {
  const passed = new Set(graph.nodes.filter((n) => n.status === "passed").map((n) => n.id));
  const prereqs = new Map<string, string[]>();

  for (const e of graph.edges) {
    if (e.type !== "requires") continue;
    prereqs.set(e.to, [...(prereqs.get(e.to) ?? []), e.from]);
  }

  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      if (n.status !== "ready" && n.status !== "locked") return n;
      const needed = prereqs.get(n.id) ?? [];
      const open = needed.every((id) => passed.has(id));
      return { ...n, status: open ? ("ready" as const) : ("locked" as const) };
    }),
  };
}

function describe(patch: Patch): string {
  switch (patch.op) {
    case "edit_node":
      return "edited";
    case "rewrite_check":
      return "exit check rewritten";
    case "insert_prereq":
      return `prerequisite added: ${patch.node.title}`;
    case "insert_recovery":
      return `recovery added: ${patch.node.title}`;
    case "insert_unit":
      return `unit added: ${patch.node.title}`;
    case "prune_node":
      return "pruned from the plan";
    case "retitle_chapters":
      return `chapters retitled: ${patch.chapters.join(" · ")}`;
  }
}

/** The node a patch is about, for the event log. Chapter retitling has no single node. */
function subjectOf(patch: Patch): string | undefined {
  return "target" in patch ? patch.target : undefined;
}

export class PatchTargetError extends Error {
  constructor(target: string) {
    super(`The plan has no node "${target}" to change.`);
    this.name = "PatchTargetError";
  }
}

export function applyPatch(graph: AtlasGraph, patch: Patch, runId: string): AtlasGraph {
  const now = new Date().toISOString();
  let nodes = graph.nodes;
  let edges = graph.edges;
  let chapters = graph.chapters;

  const requireTarget = (id: string): AtlasNode => {
    const found = graph.nodes.find((n) => n.id === id);
    if (!found) throw new PatchTargetError(id);
    return found;
  };

  switch (patch.op) {
    case "edit_node": {
      requireTarget(patch.target);
      nodes = nodes.map((n) => {
        if (n.id !== patch.target) return n;
        const next = { ...n };
        if (patch.title) next.title = patch.title;
        if (patch.why) next.why = patch.why;
        if (patch.estimate_min && next.type !== "DECISION") {
          (next as { estimate_min: number }).estimate_min = patch.estimate_min;
        }
        return next;
      });
      break;
    }

    case "rewrite_check": {
      const target = requireTarget(patch.target);
      if (target.type === "DECISION") {
        throw new Error("A decision has no exit check to rewrite.");
      }
      nodes = nodes.map((n) =>
        n.id === patch.target && n.type !== "DECISION"
          ? { ...n, exit_check: patch.exit_check }
          : n,
      );
      break;
    }

    case "insert_prereq": {
      requireTarget(patch.target);
      const id = nodeId(patch.node.title);
      nodes = [
        ...nodes,
        {
          ...patch.node,
          id,
          type: "UNIT" as const,
          status: "ready" as const,
          attempts: 0,
          resources: [],
          parent: null,
          provenance: { run_id: runId, confidence: 0.7 },
        },
      ];
      edges = [...edges, { from: id, to: patch.target, type: "requires" as const, strength: 0.9 }];
      break;
    }

    case "insert_recovery": {
      const target = requireTarget(patch.target);
      if (target.type !== "UNIT") {
        throw new Error("Only a unit can fail, so only a unit can carry a recovery.");
      }
      const id = nodeId(patch.node.title, "r");
      nodes = [
        ...nodes,
        {
          ...patch.node,
          id,
          type: "RECOVERY" as const,
          status: "ready" as const,
          resources: [],
          provenance: { run_id: runId, confidence: 0.7 },
        },
      ];
      edges = [...edges, { from: patch.target, to: id, type: "on_fail" as const, strength: 1 }];
      break;
    }

    case "insert_unit": {
      const id = nodeId(patch.node.title);
      nodes = [
        ...nodes,
        {
          ...patch.node,
          id,
          type: "UNIT" as const,
          status: "ready" as const,
          attempts: 0,
          resources: [],
          parent: null,
          provenance: { run_id: runId, confidence: 0.7 },
        },
      ];
      if (patch.after) {
        requireTarget(patch.after);
        edges = [...edges, { from: patch.after, to: id, type: "requires" as const, strength: 0.9 }];
      }
      break;
    }

    case "prune_node": {
      requireTarget(patch.target);
      if (graph.nodes.length <= 1) throw new Error("A plan cannot be emptied to nothing.");

      // Bridge across the gap so removing a middle node does not orphan everything below it.
      const incoming = edges.filter((e) => e.to === patch.target && e.type === "requires");
      const outgoing = edges.filter((e) => e.from === patch.target && e.type === "requires");
      const bridged: Edge[] = [];
      for (const up of incoming) {
        for (const down of outgoing) {
          const exists = edges.some(
            (e) => e.from === up.from && e.to === down.to && e.type === "requires",
          );
          if (!exists && up.from !== down.to) {
            bridged.push({
              from: up.from,
              to: down.to,
              type: "requires",
              strength: Math.min(up.strength, down.strength),
            });
          }
        }
      }

      // A recovery hanging off the pruned node has nothing left to recover from.
      const orphanedRecoveries = new Set(
        edges.filter((e) => e.from === patch.target && e.type === "on_fail").map((e) => e.to),
      );

      nodes = nodes.filter((n) => n.id !== patch.target && !orphanedRecoveries.has(n.id));
      edges = [
        ...edges.filter(
          (e) =>
            e.from !== patch.target &&
            e.to !== patch.target &&
            !orphanedRecoveries.has(e.from) &&
            !orphanedRecoveries.has(e.to),
        ),
        ...bridged,
      ];
      break;
    }

    case "retitle_chapters": {
      chapters = patch.chapters;
      break;
    }
  }

  const next: AtlasGraph = {
    ...graph,
    nodes,
    edges,
    chapters,
    events: [
      ...graph.events,
      { at: now, type: "node_inserted" as const, node: subjectOf(patch), detail: describe(patch) },
    ],
    mutations: [
      ...graph.mutations,
      {
        at: now,
        run_id: runId,
        op: mutationOp(patch),
        target: subjectOf(patch) ?? graph.id,
        reason: patch.reason,
        payload: patch,
        // The whole prior node and edge lists — the only reliable inverse for a bridge-and-prune.
        inverse: { nodes: graph.nodes, edges: graph.edges, chapters: graph.chapters },
      },
    ],
  };

  return recomputeStatuses(next);
}

/** Bridge the patch vocabulary to the schema's stored op names, which differ only for prune. */
function mutationOp(patch: Patch) {
  return patch.op === "prune_node" ? ("prune_unit" as const) : patch.op;
}
