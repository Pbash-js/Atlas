import { AtlasGraph } from "./atlas";
import type { AtlasGraph as Graph, AtlasNode, Edge } from "./atlas";

/**
 * Structural validation beyond what Zod can express.
 *
 * These rules are the cheap defence that does most of the quality work on generated graphs.
 * Two of them exist specifically to catch the ways an LLM fakes this job:
 *
 *   NO_CONVERGENCE  — a "DAG" where nothing ever converges is a syllabus in a DAG costume.
 *   UNGRADEABLE     — an exit check nobody can grade turns Atlas into a checkbox tracker.
 *
 * Errors reject the graph (regenerate). Warnings are advisory.
 */

export type Severity = "error" | "warning";

export interface Finding {
  code: string;
  severity: Severity;
  message: string;
  node?: string;
  edge?: { from: string; to: string; type: string };
}

export interface ValidationResult {
  ok: boolean;
  errors: Finding[];
  warnings: Finding[];
  graph?: Graph;
}

/**
 * Verbs that describe a state of mind rather than an observable act. If a rubric item contains
 * one, nothing can grade it from a text answer or a pasted artifact.
 */
const UNGRADEABLE = [
  /\bunderstand(s|ing)?\b/i,
  /\bfamiliar\b/i,
  /\bknow(s)? about\b/i,
  /\baware of\b/i,
  /\bappreciate(s)?\b/i,
  /\blearn(s)? about\b/i,
  /\bcomfortable\b/i,
  /\bgrasp(s)?\b/i,
  /\bget a feel for\b/i,
  /\bhas a (good )?sense\b/i,
];

/** Edge types that constitute the planning DAG and must therefore be acyclic. */
const ACYCLIC_EDGE_TYPES: ReadonlySet<string> = new Set(["requires", "then"]);

/** A unit larger than this is a candidate for lazy expansion rather than a leaf. */
const OVERSIZED_MIN = 90;

export function validateGraph(input: unknown): ValidationResult {
  const errors: Finding[] = [];
  const warnings: Finding[] = [];

  const parsed = AtlasGraph.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({
        code: "SHAPE",
        severity: "error",
        message: `${issue.path.join(".") || "<root>"}: ${issue.message}`,
      });
    }
    return { ok: false, errors, warnings };
  }

  const graph = parsed.data;
  const byId = new Map<string, AtlasNode>();

  for (const node of graph.nodes) {
    if (byId.has(node.id)) {
      errors.push({
        code: "DUPLICATE_ID",
        severity: "error",
        message: `node id "${node.id}" appears more than once`,
        node: node.id,
      });
      continue;
    }
    byId.set(node.id, node);
  }

  checkEdges(graph, byId, errors);
  checkAcyclic(graph, byId, errors);
  checkConvergence(graph, byId, errors);
  checkGradeability(graph, errors);
  checkRecoveryReachability(graph, errors);
  checkOrphans(graph, warnings);
  checkOversized(graph, warnings);

  return { ok: errors.length === 0, errors, warnings, graph };
}

function edgeRef(e: Edge) {
  return { from: e.from, to: e.to, type: e.type };
}

function checkEdges(graph: Graph, byId: Map<string, AtlasNode>, errors: Finding[]) {
  for (const edge of graph.edges) {
    if (edge.from === edge.to) {
      errors.push({
        code: "SELF_EDGE",
        severity: "error",
        message: `node "${edge.from}" has an edge to itself`,
        edge: edgeRef(edge),
      });
      continue;
    }

    const from = byId.get(edge.from);
    const to = byId.get(edge.to);

    if (!from || !to) {
      errors.push({
        code: "DANGLING_EDGE",
        severity: "error",
        message: `edge ${edge.from} -[${edge.type}]-> ${edge.to} references a node that does not exist`,
        edge: edgeRef(edge),
      });
      continue;
    }

    // `if` edges branch on a fact about the world, so they may only leave a DECISION and must
    // say what they branch on.
    if (edge.type === "if") {
      if (from.type !== "DECISION") {
        errors.push({
          code: "IF_SOURCE",
          severity: "error",
          message: `an 'if' edge must originate from a DECISION node, but "${edge.from}" is a ${from.type}`,
          edge: edgeRef(edge),
        });
      }
      if (!edge.condition || edge.condition.trim().length === 0) {
        errors.push({
          code: "IF_CONDITION",
          severity: "error",
          message: `the 'if' edge ${edge.from} -> ${edge.to} carries no condition`,
          edge: edgeRef(edge),
        });
      }
    } else if (edge.condition !== undefined) {
      errors.push({
        code: "STRAY_CONDITION",
        severity: "error",
        message: `a '${edge.type}' edge must not carry a condition`,
        edge: edgeRef(edge),
      });
    }

    // Failure is something a learner does to a unit, so on_fail may only leave a UNIT.
    if (edge.type === "on_fail" && from.type !== "UNIT") {
      errors.push({
        code: "ON_FAIL_SOURCE",
        severity: "error",
        message: `an 'on_fail' edge must originate from a UNIT, but "${edge.from}" is a ${from.type}`,
        edge: edgeRef(edge),
      });
    }
  }
}

/**
 * The planning subgraph (`requires` + `then`) must be a DAG. `on_fail` and `if` are exempt —
 * that is the whole "plan is acyclic, runtime isn't" distinction, as one rule.
 */
function checkAcyclic(graph: Graph, byId: Map<string, AtlasNode>, errors: Finding[]) {
  const adjacency = new Map<string, string[]>();
  for (const id of byId.keys()) adjacency.set(id, []);
  for (const edge of graph.edges) {
    if (!ACYCLIC_EDGE_TYPES.has(edge.type)) continue;
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    adjacency.get(edge.from)!.push(edge.to);
  }

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();
  for (const id of byId.keys()) colour.set(id, WHITE);
  const stack: string[] = [];
  const reported = new Set<string>();

  const visit = (id: string): void => {
    colour.set(id, GREY);
    stack.push(id);

    for (const next of adjacency.get(id) ?? []) {
      const c = colour.get(next);
      if (c === GREY) {
        const cycle = stack.slice(stack.indexOf(next)).concat(next);
        const key = cycle.join(">");
        if (!reported.has(key)) {
          reported.add(key);
          errors.push({
            code: "CYCLE",
            severity: "error",
            message: `the requires/then subgraph contains a cycle: ${cycle.join(" -> ")}`,
            node: next,
          });
        }
      } else if (c === WHITE) {
        visit(next);
      }
    }

    stack.pop();
    colour.set(id, BLACK);
  };

  for (const id of byId.keys()) {
    if (colour.get(id) === WHITE) visit(id);
  }
}

/**
 * If nothing in the graph has two or more incoming prerequisites, nothing ever converges — which
 * means the model emitted a linear reading list and dressed it as a graph. Reject and regenerate.
 */
function checkConvergence(graph: Graph, byId: Map<string, AtlasNode>, errors: Finding[]) {
  const incoming = new Map<string, number>();
  for (const edge of graph.edges) {
    if (edge.type !== "requires") continue;
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }

  const convergent = [...incoming.values()].some((n) => n >= 2);
  if (!convergent) {
    errors.push({
      code: "NO_CONVERGENCE",
      severity: "error",
      message:
        "no node has 2 or more incoming 'requires' edges — this is a linear reading list, not a dependency graph",
    });
  }
}

/** Every UNIT must be provable. Recovery checks are optional but held to the same bar. */
function checkGradeability(graph: Graph, errors: Finding[]) {
  for (const node of graph.nodes) {
    const check = node.type === "UNIT" ? node.exit_check : node.type === "RECOVERY" ? node.exit_check : undefined;
    if (node.type === "UNIT" && !check) {
      errors.push({
        code: "MISSING_EXIT_CHECK",
        severity: "error",
        message: `unit "${node.id}" has no exit check`,
        node: node.id,
      });
      continue;
    }
    if (!check) continue;

    for (const item of check.rubric) {
      const hit = UNGRADEABLE.find((re) => re.test(item));
      if (hit) {
        errors.push({
          code: "UNGRADEABLE",
          severity: "error",
          message: `"${node.id}" rubric item is not gradeable — describes a state of mind, not an observable act: "${item}"`,
          node: node.id,
        });
      }
    }
  }
}

/** A recovery the learner can never reach is dead weight the generator invented. */
function checkRecoveryReachability(graph: Graph, errors: Finding[]) {
  const reachedByFailure = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.type === "on_fail") reachedByFailure.add(edge.to);
  }

  for (const node of graph.nodes) {
    if (node.type !== "RECOVERY") continue;
    if (!reachedByFailure.has(node.id)) {
      errors.push({
        code: "RECOVERY_UNREACHABLE",
        severity: "error",
        message: `recovery "${node.id}" has no incoming 'on_fail' edge, so nothing can ever reach it`,
        node: node.id,
      });
    }
  }
}

function checkOrphans(graph: Graph, warnings: Finding[]) {
  const connected = new Set<string>();
  for (const edge of graph.edges) {
    connected.add(edge.from);
    connected.add(edge.to);
  }

  for (const node of graph.nodes) {
    if (graph.nodes.length > 1 && !connected.has(node.id)) {
      warnings.push({
        code: "ORPHAN",
        severity: "warning",
        message: `node "${node.id}" has no edges — it is not part of any path to the goal`,
        node: node.id,
      });
    }
  }
}

function checkOversized(graph: Graph, warnings: Finding[]) {
  const hasChildren = new Set<string>();
  for (const node of graph.nodes) {
    if (node.type === "UNIT" && node.parent) hasChildren.add(node.parent);
  }

  for (const node of graph.nodes) {
    if (node.type !== "UNIT") continue;
    if (node.estimate_min > OVERSIZED_MIN && !hasChildren.has(node.id)) {
      warnings.push({
        code: "OVERSIZED",
        severity: "warning",
        message: `unit "${node.id}" is ${node.estimate_min} min — over the ${OVERSIZED_MIN} min expansion threshold`,
        node: node.id,
      });
    }
  }
}

/** Convenience for callers that want to fail loudly. */
export function assertValid(input: unknown): Graph {
  const result = validateGraph(input);
  if (!result.ok) {
    const lines = result.errors.map((e) => `  [${e.code}] ${e.message}`).join("\n");
    throw new Error(`Atlas graph failed validation:\n${lines}`);
  }
  return result.graph!;
}
