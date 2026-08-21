import { z } from "zod";

/**
 * The Atlas graph schema.
 *
 * One JSON document is the whole product: the graph IS the file, the UI is a view over it.
 * `events` is append-only and is the source of truth — status, ETA and the learner profile are
 * all projections of it. That is what makes "why did it do that?" answerable.
 *
 * Three node types only. CONCEPT/SKILL/TASK/MISSION/PROJECT differ solely in size and evidence
 * type, both of which are fields; ASSESSMENT is the `exit_check` field (as a separate node type
 * it would permit units with no check, which is the failure mode); RESOURCE is a field.
 */

export const NodeId = z.string().min(1);

/** What the learner produces to prove a unit. Drives how the Examiner grades. */
export const Evidence = z.enum(["explain", "solve", "build", "artifact"]);

/** Icon/rendering tag only — carries no behaviour. */
export const UnitKind = z.enum(["concept", "skill", "task", "project", "checkpoint"]);

export const NodeStatus = z.enum([
  "locked",
  "ready",
  "in_progress",
  "passed",
  "failed",
  "bounced",
  "skipped",
  "pruned",
]);

export const ResourceKind = z.enum(["video", "text", "paper", "course", "docs", "exercise"]);

/**
 * Every UNIT carries one. A node is not done because you clicked done — it is done when this
 * passes. `rubric` items must be individually checkable; see GRADEABILITY in validate.ts.
 */
export const ExitCheck = z.object({
  evidence: Evidence,
  prompt: z.string().min(10),
  rubric: z.array(z.string().min(3)).min(2).max(4),
});

/**
 * Resources are fetched and verified by the app, never trusted from the model.
 * `status: "ok"` requires a non-null `verified` date. One dead link on node 1 kills trust in
 * the whole graph, so an unverified resource ships as an honest badge instead.
 */
export const Resource = z
  .object({
    url: z.string().url(),
    kind: ResourceKind,
    title: z.string().optional(),
    minutes: z.number().int().positive(),
    cost: z.number().nonnegative().default(0),
    verified: z.string().nullable(),
    status: z.enum(["ok", "dead", "unverified"]),
  })
  .refine((r) => r.status !== "ok" || r.verified !== null, {
    message: "a resource with status 'ok' must carry a verification date",
    path: ["verified"],
  });

/** Generated eagerly with the node (free), rendered as "what usually goes wrong here". */
export const Pitfall = z.object({
  symptom: z.string().min(3),
  cause: z.string().min(3),
});

export const Provenance = z.object({
  run_id: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

const NodeBase = z.object({
  id: NodeId,
  title: z.string().min(3),
  why: z.string().min(10),
  status: NodeStatus,
  provenance: Provenance,
});

export const UnitNode = NodeBase.extend({
  type: z.literal("UNIT"),
  kind: UnitKind,
  estimate_min: z.number().int().positive(),
  attempts: z.number().int().nonnegative().default(0),
  exit_check: ExitCheck,
  known_pitfalls: z.array(Pitfall).default([]),
  resources: z.array(Resource).default([]),
  /** Set when this unit was produced by expanding a parent (lazy expansion). */
  parent: NodeId.nullable().default(null),
});

/**
 * Branches on a fact about the WORLD, not about the learner — which is what separates it from a
 * UNIT. No exit check. In the schema from v1 so v1.1 needs no migration; UI deferred.
 */
export const DecisionNode = NodeBase.extend({
  type: z.literal("DECISION"),
  question: z.string().min(5),
});

/**
 * Materialized lazily — only when the learner actually fails. Reachable only via an `on_fail`
 * edge, never part of the planned path, excluded from progress %.
 */
export const RecoveryNode = NodeBase.extend({
  type: z.literal("RECOVERY"),
  estimate_min: z.number().int().positive(),
  diagnosis: z.string().min(10),
  remediation: z.array(z.string().min(3)).min(1),
  exit_check: ExitCheck.optional(),
  resources: z.array(Resource).default([]),
});

export const AtlasNode = z.discriminatedUnion("type", [UnitNode, DecisionNode, RecoveryNode]);

/**
 * Semantics live on edges, which is what dissolves the "is it a DAG?" question:
 * `requires` + `then` must be acyclic (validated); `on_fail` and `if` may cycle.
 */
export const EdgeType = z.enum(["requires", "then", "on_fail", "if"]);

export const Edge = z.object({
  from: NodeId,
  to: NodeId,
  type: EdgeType,
  /**
   * Prerequisite confidence. Decremented by skip-and-survive; dropped below 0.3. This is the
   * only mechanism that makes the graph SHRINK — without it, it only ever grows into a swamp.
   */
  strength: z.number().min(0).max(1).default(1),
  /** Required on `if` edges, forbidden elsewhere. */
  condition: z.string().optional(),
});

export const EventType = z.enum([
  "opened",
  "attempted",
  "passed",
  "failed",
  "skipped",
  "expanded",
  "resource_swapped",
  "node_inserted",
  "edge_weakened",
]);

export const AtlasEvent = z.object({
  at: z.string().min(1),
  type: EventType,
  node: NodeId.optional(),
  /** Minutes actually spent — feeds observed throughput, which drives the honest ETA. */
  minutes: z.number().nonnegative().optional(),
  /** Which modality was in play — feeds modality yield in the learner profile. */
  modality: ResourceKind.optional(),
  detail: z.string().optional(),
});

/** The only ways the model may change the graph after initial generation. */
export const PatchOp = z.enum([
  "insert_unit",
  "insert_prereq",
  "insert_recovery",
  "split_unit",
  "swap_resource",
  "weaken_edge",
  "prune_unit",
  "expand_unit",
  // Revisions to an existing card rather than to the shape of the graph.
  "edit_node",
  "rewrite_check",
  "retitle_chapters",
]);

/**
 * After initial generation the model NEVER returns a whole graph — only validated patches.
 * Wholesale regeneration silently destroying weeks of progress is the #1 way this class of app
 * loses its user, and this is the one-line policy that prevents it.
 */
export const Mutation = z.object({
  at: z.string().min(1),
  run_id: z.string().min(1),
  op: PatchOp,
  target: NodeId,
  reason: z.string().min(5),
  payload: z.unknown(),
  /** Enough state to reverse the patch. */
  inverse: z.unknown().optional(),
});

export const Goal = z.object({
  statement: z.string().min(10),
  /** One sentence: what can you do that you couldn't before. Drives backwards decomposition. */
  terminal_capability: z.string().min(10),
  created: z.string().min(1),
});

export const AtlasGraph = z.object({
  atlas_version: z.literal("1"),
  id: z.string().min(1),
  goal: Goal,
  /**
   * Chapter titles, in order, authored with the graph. Chapters themselves are derived from ranks
   * at render time — only their names are stored, because a name is the one part that cannot be
   * computed from the shape of the graph.
   */
  chapters: z.array(z.string()).default([]),
  nodes: z.array(AtlasNode).min(1),
  edges: z.array(Edge),
  events: z.array(AtlasEvent).default([]),
  mutations: z.array(Mutation).default([]),
});

export type Evidence = z.infer<typeof Evidence>;
export type UnitKind = z.infer<typeof UnitKind>;
export type NodeStatus = z.infer<typeof NodeStatus>;
export type ExitCheck = z.infer<typeof ExitCheck>;
export type Resource = z.infer<typeof Resource>;
export type Pitfall = z.infer<typeof Pitfall>;
export type UnitNode = z.infer<typeof UnitNode>;
export type DecisionNode = z.infer<typeof DecisionNode>;
export type RecoveryNode = z.infer<typeof RecoveryNode>;
export type AtlasNode = z.infer<typeof AtlasNode>;
export type EdgeType = z.infer<typeof EdgeType>;
export type Edge = z.infer<typeof Edge>;
export type EventType = z.infer<typeof EventType>;
export type AtlasEvent = z.infer<typeof AtlasEvent>;
export type PatchOp = z.infer<typeof PatchOp>;
export type Mutation = z.infer<typeof Mutation>;
export type Goal = z.infer<typeof Goal>;
export type AtlasGraph = z.infer<typeof AtlasGraph>;
