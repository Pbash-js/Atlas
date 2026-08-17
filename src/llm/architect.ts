import { z } from "zod";
import type { AtlasGraph, Edge, UnitNode } from "../schema/atlas";
import { validateGraph, type Finding } from "../schema/validate";
import { extractJson, type ReasoningModel } from "./model";

/**
 * The Architect: goal → graph.
 *
 * The model returns a compact draft, not a finished Atlas graph. Everything mechanical — node
 * type, status, attempts, provenance, empty resource and event arrays — is filled in here, so the
 * model only has to get the part that needs judgement right, and there is far less surface for it
 * to get wrong.
 *
 * Its output is then run through the real validator, and if that rejects, the errors go back to
 * the model as a repair instruction. That loop is why the progress readout is honest: each step
 * shown to the user corresponds to a request that actually happened.
 */

const DraftNode = z.object({
  id: z.string().min(1),
  kind: z.enum(["concept", "skill", "task", "project", "checkpoint"]),
  title: z.string().min(3),
  why: z.string().min(10),
  estimate_min: z.number().int().positive(),
  exit_check: z.object({
    evidence: z.enum(["explain", "solve", "build", "artifact"]),
    prompt: z.string().min(10),
    rubric: z.array(z.string().min(3)).min(2).max(4),
  }),
  known_pitfalls: z
    .array(z.object({ symptom: z.string().min(3), cause: z.string().min(3) }))
    .default([]),
});

const Draft = z.object({
  goal: z.object({
    statement: z.string().min(10),
    terminal_capability: z.string().min(10),
  }),
  chapters: z.array(z.string()).default([]),
  nodes: z.array(DraftNode).min(4),
  edges: z
    .array(
      z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        type: z.enum(["requires", "then"]),
        strength: z.number().min(0).max(1).default(1),
      }),
    )
    .min(3),
});

type Draft = z.infer<typeof Draft>;

const SYSTEM = `You are the Architect of Atlas. You turn a stated goal into a dependency graph of learning units.

Follow this protocol exactly.

1. Extract the TERMINAL CAPABILITY: one sentence naming what the learner will be able to DO that they cannot do now. Not a topic — a demonstrable act.
2. Decompose BACKWARDS from that capability: ask "what must already be true to do this?", then repeat on each answer. Two levels deep. Backwards decomposition is what makes branches converge; forwards decomposition just produces a syllabus.
3. PRUNE anything the learner already holds (given below).
4. VERIFY each edge: keep an edge only if the source is genuinely REQUIRED to attempt the target. Drop edges that are merely related or thematically adjacent.
5. AUTHOR an exit check for every node.

HARD RULES — output that breaks these is rejected and you will be asked again:

- CONVERGENCE: at least one node must have 2 or more incoming "requires" edges. A graph where every node has at most one prerequisite is a reading list, not a dependency graph. Aim for several convergent nodes.
- GRADEABLE RUBRICS: every rubric item must describe an OBSERVABLE act that can be judged from a written answer or a pasted artifact. NEVER use the words: understand, familiar, know about, aware of, appreciate, learn about, comfortable, grasp. Write "produces X", "names the three Y", "the output matches Z" instead.
- 2 to 4 rubric items per node. No more, no fewer.
- "evidence" is ONE WORD chosen from exactly these four: explain, solve, build, artifact. It names the FORM the proof takes — not a description of it. Write "artifact", never "a completed audience profile document".
- "kind" is likewise one word from exactly: concept, skill, task, project, checkpoint.
- NO CYCLES in requires/then edges.
- Every edge's "from" and "to" must be ids that exist in nodes.
- Node ids: short, lowercase, prefixed "n_".
- 12 to 18 nodes. Sizes between 30 and 120 minutes.
- "why" states why THIS learner needs it for THIS goal, in one concrete sentence. Never generic.
- chapters: 3 to 6 short evocative section names, in order, covering the arc of the plan. They title groups of the graph, so they should read as a progression.

Reply with a single JSON object and nothing else. No prose, no code fences.

{
  "goal": { "statement": "...", "terminal_capability": "..." },
  "chapters": ["...", "..."],
  "nodes": [
    { "id": "n_x", "kind": "skill", "title": "...", "why": "...",
      "estimate_min": 45,
      "exit_check": { "evidence": "artifact", "prompt": "...", "rubric": ["...", "..."] },
      "known_pitfalls": [ { "symptom": "...", "cause": "..." } ] }
  ],
  "edges": [ { "from": "n_a", "to": "n_b", "type": "requires", "strength": 0.9 } ]
}`;

export interface ArchitectInput {
  goal: string;
  weeklyHours: string;
  known: string;
}

export type Phase =
  | { step: "drafting"; attempt: number }
  | { step: "checking"; attempt: number }
  | { step: "repairing"; attempt: number; problems: string[] }
  | { step: "done" };

export interface ArchitectResult {
  graph: AtlasGraph;
  attempts: number;
  warnings: Finding[];
}

const MAX_ATTEMPTS = 3;

function userPrompt(input: ArchitectInput): string {
  const known = input.known
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  return [
    `GOAL: ${input.goal}`,
    `TIME AVAILABLE: ${input.weeklyHours} per week.`,
    known.length
      ? `ALREADY HELD (do not plan these again):\n${known.map((k) => `- ${k}`).join("\n")}`
      : "ALREADY HELD: nothing stated; assume a capable beginner.",
  ].join("\n\n");
}

/** Fill in everything mechanical, so the model never has to emit it. */
function expand(draft: Draft, runId: string): AtlasGraph {
  const ids = new Set(draft.nodes.map((n) => n.id));
  const edges: Edge[] = draft.edges
    .filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to)
    .map((e) => ({ from: e.from, to: e.to, type: e.type, strength: e.strength }));

  // Nothing is passed yet, so a node is ready exactly when it has no prerequisites.
  const hasPrereq = new Set(edges.filter((e) => e.type === "requires").map((e) => e.to));

  const nodes: UnitNode[] = draft.nodes.map((n) => ({
    id: n.id,
    type: "UNIT",
    kind: n.kind,
    title: n.title,
    why: n.why,
    status: hasPrereq.has(n.id) ? "locked" : "ready",
    estimate_min: n.estimate_min,
    attempts: 0,
    exit_check: n.exit_check,
    known_pitfalls: n.known_pitfalls,
    resources: [],
    parent: null,
    provenance: { run_id: runId, confidence: 0.7 },
  }));

  return {
    atlas_version: "1",
    id: runId,
    goal: {
      statement: draft.goal.statement,
      terminal_capability: draft.goal.terminal_capability,
      created: new Date().toISOString().slice(0, 10),
    },
    chapters: draft.chapters,
    nodes,
    edges,
    events: [],
    mutations: [],
  };
}

function planId(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 32);
  return `atlas_${slug || "plan"}_${Date.now().toString(36)}`;
}

/**
 * Turn validator findings into an instruction the model can act on. The codes are ours; the model
 * only ever sees plain sentences about what was wrong.
 */
/**
 * Zod's default message is the whole issue tree as JSON. Rendering that into the loading screen is
 * unreadable, and feeding it back to the model wastes hundreds of tokens restating the same fault
 * once per node. Collapse to one short line per DISTINCT fault, with a count.
 */
function describeDraftError(err: unknown): string[] {
  if (!(err instanceof z.ZodError)) {
    return [err instanceof Error ? err.message : String(err)];
  }

  const counts = new Map<string, number>();

  for (const issue of err.issues) {
    // Drop array indices: nodes.0.exit_check.evidence and nodes.7.… are the same fault.
    const field = issue.path.filter((p) => typeof p !== "number").join(".") || "<root>";

    let what: string;
    if (issue.code === "invalid_enum_value") {
      what = `must be exactly one of ${issue.options.map((o) => `"${o}"`).join(", ")} — a single word, not a description`;
    } else if (issue.code === "invalid_type") {
      what = `expected ${issue.expected}, received ${issue.received}`;
    } else {
      what = issue.message;
    }

    const line = `${field}: ${what}`;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }

  return [...counts.entries()]
    .slice(0, 6)
    .map(([line, n]) => (n > 1 ? `${line} (${n} nodes)` : line));
}

function repairInstruction(errors: Finding[]): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const e of errors) {
    if (seen.has(e.code)) continue;
    seen.add(e.code);

    switch (e.code) {
      case "NO_CONVERGENCE":
        lines.push(
          "No node had two or more incoming 'requires' edges. Rework the graph so several nodes genuinely need more than one prerequisite.",
        );
        break;
      case "UNGRADEABLE":
        lines.push(
          "Some rubric items described a state of mind rather than an observable act. Rewrite every rubric item as something checkable in a written answer or a pasted artifact.",
        );
        break;
      case "CYCLE":
        lines.push("The prerequisite edges contained a cycle. Remove it.");
        break;
      case "DANGLING_EDGE":
        lines.push("Some edges referenced node ids that do not exist. Every edge must join two real nodes.");
        break;
      case "SHAPE":
        lines.push("The JSON did not match the required shape. Follow the template exactly.");
        break;
      default:
        lines.push(e.message);
    }
  }

  return lines;
}

export async function architect(
  model: ReasoningModel,
  input: ArchitectInput,
  onPhase: (p: Phase) => void,
  signal?: AbortSignal,
): Promise<ArchitectResult> {
  const id = planId(input.goal);
  let prompt = userPrompt(input);
  let lastProblems: string[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    onPhase(attempt === 1 ? { step: "drafting", attempt } : { step: "repairing", attempt, problems: lastProblems });

    const raw = await model.generate({ system: SYSTEM, input: prompt, signal });

    onPhase({ step: "checking", attempt });

    let graph: AtlasGraph;
    try {
      const draft = Draft.parse(extractJson(raw));
      graph = expand(draft, id);
    } catch (err) {
      lastProblems = describeDraftError(err);
      prompt = `${userPrompt(input)}\n\nYour previous reply could not be read:\n- ${lastProblems.join("\n- ")}\n\nReply again with a single valid JSON object matching the template exactly.`;
      continue;
    }

    const result = validateGraph(graph);
    if (result.ok && result.graph) {
      onPhase({ step: "done" });
      return { graph: result.graph, attempts: attempt, warnings: result.warnings };
    }

    lastProblems = repairInstruction(result.errors);
    prompt = `${userPrompt(input)}\n\nYour previous graph was rejected:\n- ${lastProblems.join("\n- ")}\n\nProduce a corrected graph. Reply with the JSON object only.`;
  }

  throw new Error(
    `The plan could not be drawn after ${MAX_ATTEMPTS} attempts. Last problems: ${lastProblems.join(" ")}`,
  );
}
