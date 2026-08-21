import type { AtlasGraph, AtlasNode } from "../schema/atlas";
import { Patch } from "../graph/mutate";
import { extractJson, type ReasoningModel } from "./model";

/**
 * The Mutator: turn an instruction into one validated patch.
 *
 * Each menu action names its own operation, so the model is never asked to choose one — it only
 * fills in a payload for an op that is already decided. That is a far narrower job than "decide
 * what to do and then do it", and it is why these succeed on the first attempt where the initial
 * plan draw sometimes needs a repair pass.
 *
 * Free-text asks are the exception: there the model does pick the op, from the same closed list.
 */

export type MutationIntent =
  | { kind: "edit_node"; nodeId: string }
  | { kind: "rewrite_check"; nodeId: string }
  | { kind: "insert_prereq"; nodeId: string }
  | { kind: "insert_recovery"; nodeId: string }
  | { kind: "prune_node"; nodeId: string }
  | { kind: "explain"; nodeId: string }
  | { kind: "insert_unit" }
  | { kind: "retitle_chapters" }
  | { kind: "ask"; text: string; nodeId: string | null };

/** Either a change to apply, or an answer to read. "Explain" never edits the graph. */
export type MutationResult =
  | { type: "patch"; patch: Patch }
  | { type: "answer"; text: string };

const RULES = `RULES for any node you write:
- "exit_check.evidence" is ONE WORD from exactly: explain, solve, build, artifact.
- "exit_check.rubric" has 2 to 4 items. Every item must describe an OBSERVABLE act, checkable from a written answer or a pasted artifact. NEVER use: understand, familiar, know about, aware of, appreciate, learn about, comfortable, grasp.
- "kind" is ONE WORD from exactly: concept, skill, task, project, checkpoint.
- "why" says why THIS learner needs it for THIS goal, concretely. Never generic.
- "reason" is one sentence explaining the change you made, for the record.

Reply with a single JSON object and nothing else. No prose, no code fences.`;

const UNIT_SHAPE = `{ "kind": "skill", "title": "...", "why": "...", "estimate_min": 45,
  "exit_check": { "evidence": "build", "prompt": "...", "rubric": ["...", "..."] },
  "known_pitfalls": [ { "symptom": "...", "cause": "..." } ] }`;

function nodeContext(node: AtlasNode): string {
  const lines = [
    `id: ${node.id}`,
    `title: ${node.title}`,
    `why: ${node.why}`,
    `type: ${node.type}`,
  ];
  if (node.type !== "DECISION") lines.push(`estimate_min: ${node.estimate_min}`);
  if (node.type === "UNIT") lines.push(`kind: ${node.kind}`);
  if (node.type !== "DECISION" && node.exit_check) {
    lines.push(`exit_check.evidence: ${node.exit_check.evidence}`);
    lines.push(`exit_check.prompt: ${node.exit_check.prompt}`);
    lines.push(`exit_check.rubric:\n${node.exit_check.rubric.map((r) => `  - ${r}`).join("\n")}`);
  }
  return lines.join("\n");
}

function planContext(graph: AtlasGraph): string {
  const units = graph.nodes.filter((n) => n.type === "UNIT");
  return [
    `GOAL: ${graph.goal.statement}`,
    `TERMINAL CAPABILITY: ${graph.goal.terminal_capability}`,
    `CHAPTERS: ${graph.chapters.join(" · ") || "(none named)"}`,
    `THE PLAN (${units.length} units, in order):`,
    units.map((n) => `- ${n.id} · ${n.title} [${n.status}]`).join("\n"),
  ].join("\n");
}

interface Spec {
  system: string;
  input: string;
}

function specFor(graph: AtlasGraph, intent: MutationIntent, node: AtlasNode | null): Spec {
  switch (intent.kind) {
    case "edit_node":
      return {
        system: `You revise one card in a learning plan. Sharpen its title, its "why", and its time estimate. Keep it the same card doing the same job — do not repurpose it.\n\n${RULES}\n\n{ "op": "edit_node", "target": "<id>", "title": "...", "why": "...", "estimate_min": 45, "reason": "..." }`,
        input: `${planContext(graph)}\n\nTHE CARD TO REVISE:\n${nodeContext(node!)}\n\nReturn the edit_node patch with target "${node!.id}".`,
      };

    case "rewrite_check":
      return {
        system: `You rewrite the exit check for one card in a learning plan, so that passing it is unambiguous and checkable.\n\n${RULES}\n\n{ "op": "rewrite_check", "target": "<id>", "exit_check": { "evidence": "build", "prompt": "...", "rubric": ["...", "..."] }, "reason": "..." }`,
        input: `${planContext(graph)}\n\nTHE CARD:\n${nodeContext(node!)}\n\nReturn the rewrite_check patch with target "${node!.id}".`,
      };

    case "insert_prereq":
      return {
        system: `You add ONE missing prerequisite immediately before a card in a learning plan. It must be genuinely REQUIRED to attempt that card — not merely related — and must not duplicate anything already in the plan.\n\n${RULES}\n\n{ "op": "insert_prereq", "target": "<id>", "node": ${UNIT_SHAPE}, "reason": "..." }`,
        input: `${planContext(graph)}\n\nTHE CARD THE NEW PREREQUISITE FEEDS INTO:\n${nodeContext(node!)}\n\nReturn the insert_prereq patch with target "${node!.id}".`,
      };

    case "insert_recovery":
      return {
        system: `You add a RECOVERY beside a card the learner has struggled with. A recovery is an excursion off the main path: it names what went wrong and the steps back. It is not a new prerequisite.\n\n${RULES}\n\n{ "op": "insert_recovery", "target": "<id>", "node": { "title": "...", "why": "...", "estimate_min": 30, "diagnosis": "what specifically went wrong", "remediation": ["step", "step"], "exit_check": { "evidence": "build", "prompt": "...", "rubric": ["...", "..."] } }, "reason": "..." }`,
        input: `${planContext(graph)}\n\nTHE CARD THAT FAILED:\n${nodeContext(node!)}\n\nReturn the insert_recovery patch with target "${node!.id}".`,
      };

    case "prune_node":
      return {
        system: `You remove one card from a learning plan and justify it. Say plainly why it does not earn its place — redundant with another card, not required for the goal, or too trivial to be its own step.\n\n${RULES}\n\n{ "op": "prune_node", "target": "<id>", "reason": "..." }`,
        input: `${planContext(graph)}\n\nTHE CARD TO REMOVE:\n${nodeContext(node!)}\n\nReturn the prune_node patch with target "${node!.id}".`,
      };

    case "insert_unit":
      return {
        system: `You add ONE new card to a learning plan — something the plan is genuinely missing on the way to its goal. Do not duplicate an existing card. If it should follow an existing card, set "after" to that card's id; otherwise set "after" to null.\n\n${RULES}\n\n{ "op": "insert_unit", "after": "<id or null>", "node": ${UNIT_SHAPE}, "reason": "..." }`,
        input: `${planContext(graph)}\n\nReturn the insert_unit patch.`,
      };

    case "retitle_chapters":
      return {
        system: `You name the chapters of a learning plan. Chapters are consecutive groups of the plan, in order, and their names should read as a progression through the work — evocative but concrete. Return between 3 and 6 names.\n\n${RULES}\n\n{ "op": "retitle_chapters", "chapters": ["...", "..."], "reason": "..." }`,
        input: `${planContext(graph)}\n\nReturn the retitle_chapters patch.`,
      };

    case "explain":
      return {
        system: `You explain one step of a learning plan in plain language, to someone who found it confusing. Two or three short sentences. No jargon unless you define it. Do not restate the title back at them. Reply with JSON only: { "answer": "..." }`,
        input: `${planContext(graph)}\n\nTHE CARD TO EXPLAIN:\n${nodeContext(node!)}`,
      };

    case "ask": {
      const focus = node
        ? `THE CARD CURRENTLY OPEN:\n${nodeContext(node)}\n\n`
        : "No single card is open; the question is about the plan as a whole.\n\n";
      return {
        system: `You act on a request about a learning plan. Choose ONE:

If it asks you to CHANGE the plan, return exactly one patch from this list:
- { "op": "edit_node", "target": "<id>", "title": "...", "why": "...", "estimate_min": 45, "reason": "..." }
- { "op": "rewrite_check", "target": "<id>", "exit_check": { "evidence": "build", "prompt": "...", "rubric": ["...","..."] }, "reason": "..." }
- { "op": "insert_prereq", "target": "<id>", "node": ${UNIT_SHAPE}, "reason": "..." }
- { "op": "insert_recovery", "target": "<id>", "node": { "title": "...", "why": "...", "estimate_min": 30, "diagnosis": "...", "remediation": ["..."] }, "reason": "..." }
- { "op": "insert_unit", "after": "<id or null>", "node": ${UNIT_SHAPE}, "reason": "..." }
- { "op": "prune_node", "target": "<id>", "reason": "..." }
- { "op": "retitle_chapters", "chapters": ["...","..."], "reason": "..." }

If it only asks a QUESTION, return { "answer": "..." } — two or three short sentences.

Every "target" and "after" MUST be an id that appears in the plan below.

NEVER SUBSTITUTE. If the request names a card, an id, or a topic that is not in the plan, do NOT pick a different card and act on that instead. Return { "answer": "..." } saying plainly that it is not in the plan. Acting on the wrong card is far worse than declining — especially for prune_node, which destroys work.

${RULES}`,
        input: `${planContext(graph)}\n\n${focus}THE REQUEST: ${intent.text}`,
      };
    }
  }
}

/** Which intents need a node, so a missing selection fails clearly instead of hitting the model. */
export function needsNode(intent: MutationIntent): boolean {
  return (
    intent.kind === "edit_node" ||
    intent.kind === "rewrite_check" ||
    intent.kind === "insert_prereq" ||
    intent.kind === "insert_recovery" ||
    intent.kind === "prune_node" ||
    intent.kind === "explain"
  );
}

export async function mutate(
  model: ReasoningModel,
  graph: AtlasGraph,
  intent: MutationIntent,
  signal?: AbortSignal,
): Promise<MutationResult> {
  const nodeId = "nodeId" in intent ? intent.nodeId : null;
  const node = nodeId ? (graph.nodes.find((n) => n.id === nodeId) ?? null) : null;

  if (needsNode(intent) && !node) {
    throw new Error("Select a card first — that action works on one card.");
  }

  const { system, input } = specFor(graph, intent, node);
  const raw = await model.generate({ system, input, signal });
  const parsed = extractJson(raw) as Record<string, unknown>;

  // An answer and a patch are distinguishable by shape, so a model that answers a change request
  // in prose degrades to a readable reply rather than a validation error.
  if (typeof parsed.answer === "string" && !parsed.op) {
    return { type: "answer", text: parsed.answer };
  }

  const patch = Patch.parse(parsed);
  return { type: "patch", patch };
}
