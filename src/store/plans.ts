import type { AtlasGraph, Resource } from "../schema/atlas";
import { validateGraph } from "../schema/validate";
import { urlKey } from "../resources/verify";
import { recomputeStatuses } from "../graph/mutate";
import golden from "../../fixtures/golden-bs-streaming.json";

/**
 * Plan storage. Local-first: the graph IS the record, so a plan is just its graph plus two
 * timestamps. Everything the reading room shows — unit counts, progress, chapter pips — is
 * computed from the graph, never stored alongside it and never invented.
 */

const KEY = "atlas.plans";

export interface StoredPlan {
  id: string;
  graph: AtlasGraph;
  created: string;
  touched: string;
}

interface Persisted {
  id: string;
  graph: unknown;
  created: string;
  touched: string;
}

function read(): Persisted[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(plans: Persisted[]) {
  localStorage.setItem(KEY, JSON.stringify(plans));
}

/** Drops any stored plan whose graph no longer validates rather than rendering a broken one. */
export function listPlans(): StoredPlan[] {
  const out: StoredPlan[] = [];

  for (const p of read()) {
    const result = validateGraph(p.graph);
    if (!result.ok || !result.graph) continue;
    out.push({ id: p.id, graph: result.graph, created: p.created, touched: p.touched });
  }

  return out.sort((a, b) => b.touched.localeCompare(a.touched));
}

export function savePlan(graph: AtlasGraph): StoredPlan {
  const now = new Date().toISOString();
  const existing = read();
  const prior = existing.find((p) => p.id === graph.id);

  const record: Persisted = {
    id: graph.id,
    graph,
    created: prior?.created ?? now,
    touched: now,
  };

  write([record, ...existing.filter((p) => p.id !== graph.id)]);
  return { ...record, graph };
}

/**
 * Attach freshly-found resources to one node and persist the plan.
 *
 * Returns a new graph rather than mutating in place, so React sees a changed reference and the
 * panel re-renders. Resources are replaced wholesale, not merged: a second search is the user
 * asking for a better answer than the one already there.
 */
export function setNodeResources(
  graph: AtlasGraph,
  nodeId: string,
  resources: Resource[],
): AtlasGraph {
  const next: AtlasGraph = {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.id === nodeId && n.type !== "DECISION" ? { ...n, resources } : n,
    ),
    events: [
      ...graph.events,
      {
        at: new Date().toISOString(),
        type: "resource_swapped" as const,
        node: nodeId,
        detail: `${resources.length} resource${resources.length === 1 ? "" : "s"} found by web search`,
      },
    ],
  };

  savePlan(next);
  return next;
}

/**
 * Add one resource the user found themselves — via the "Open in Google AI Mode" hand-off, or from
 * anywhere else — and persist the plan. Appends rather than replaces: a manual add is "here is one
 * more thing I found," not "throw away what was there," which is the opposite intent from a fresh
 * Librarian search. De-duplicates by normalised URL so pasting the same link twice is a no-op.
 */
export function addManualResource(graph: AtlasGraph, nodeId: string, resource: Resource): AtlasGraph {
  const target = graph.nodes.find((n) => n.id === nodeId);
  if (!target || target.type === "DECISION") return graph;

  const key = urlKey(resource.url);
  const already = target.resources.some((r) => urlKey(r.url) === key);
  if (already) return graph;

  const next: AtlasGraph = {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.id === nodeId && n.type !== "DECISION" ? { ...n, resources: [...n.resources, resource] } : n,
    ),
    events: [
      ...graph.events,
      {
        at: new Date().toISOString(),
        type: "resource_swapped" as const,
        node: nodeId,
        detail: "added by hand, after Google AI Mode",
      },
    ],
  };

  savePlan(next);
  return next;
}

/**
 * Mark a card passed after a quiz cleared the bar, and reopen whatever it unlocked.
 *
 * Status recomputation runs through the same function the patch layer uses, so passing a card by
 * quiz and passing it by any future route open downstream cards by identical rules.
 */
export function markPassed(graph: AtlasGraph, nodeId: string): AtlasGraph {
  const next: AtlasGraph = {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === nodeId ? { ...n, status: "passed" as const } : n)),
    events: [
      ...graph.events,
      {
        at: new Date().toISOString(),
        type: "passed" as const,
        node: nodeId,
        detail: "quiz cleared the bar",
      },
    ],
  };
  return recomputeStatuses(next);
}

export function touchPlan(id: string) {
  const existing = read();
  const found = existing.find((p) => p.id === id);
  if (!found) return;
  found.touched = new Date().toISOString();
  write(existing);
}

export function removePlan(id: string) {
  write(read().filter((p) => p.id !== id));
}

/**
 * The Black-Scholes graph ships as a worked example so a first run has something real to open.
 * It is seeded once; delete it in the app and it stays deleted.
 */
const SEEDED = "atlas.seeded";

export function seedOnce() {
  try {
    if (localStorage.getItem(SEEDED)) return;
    localStorage.setItem(SEEDED, new Date().toISOString());
    const result = validateGraph(golden);
    if (result.ok && result.graph) savePlan(result.graph);
  } catch {
    // A private-mode browser without storage still runs; it just starts empty each time.
  }
}

export function relativeDay(iso: string): string {
  const then = new Date(iso).getTime();
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "last week";
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}
