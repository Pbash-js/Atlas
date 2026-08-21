import type { AtlasGraph, AtlasNode } from "../schema/atlas";
import {
  overallStrength,
  ROTATION_FLOOR,
  type NodeMastery,
} from "./mastery";

/**
 * Testing the whole plan rather than one card.
 *
 * The per-card quiz picks concepts. This picks CARDS first, then leans on the existing per-card
 * generator for the concepts inside each — which is what keeps concept labels stable, since the
 * generator only reuses a label when it can see that card's own history.
 *
 * Eligibility is the part that matters most. Quizzing someone on a card they have not reached is
 * not a test, it is a trick: locked cards are excluded outright. A card earns its way in by
 * having been quizzed before, or by having been passed — the second case is exactly the material
 * most worth revisiting, and it usually has no concept history at all yet.
 */

export const PLAN_QUIZ_CARDS = 4;
export const PLAN_QUIZ_PER_CARD = 2;

/** A passed-but-never-quizzed card is an unknown, and unknowns are worth asking about. */
const UNTESTED_WEIGHT = 0.75;

export interface CardCandidate {
  nodeId: string;
  title: string;
  mastery: NodeMastery | null;
  /** Mean concept strength, or null when the card has never been quizzed. */
  grasp: number | null;
  weight: number;
  lastQuiz: string | null;
}

export type MasteryMap = Map<string, NodeMastery | null>;

function staleness(lastQuiz: string | null, now: number): number {
  if (!lastQuiz) return 2;
  const days = Math.max(0, (now - new Date(lastQuiz).getTime()) / 86_400_000);
  return 1 + Math.min(days / 14, 1);
}

export function eligibleCards(
  graph: AtlasGraph,
  masteries: MasteryMap,
  now = Date.now(),
): CardCandidate[] {
  const out: CardCandidate[] = [];

  for (const node of graph.nodes) {
    if (node.type === "DECISION") continue;
    if (node.status === "locked" || node.status === "pruned") continue;

    const mastery = masteries.get(node.id) ?? null;
    const tested = Boolean(mastery && mastery.concepts.length > 0);
    if (!tested && node.status !== "passed") continue;

    const grasp = mastery ? overallStrength(mastery) : null;
    const base = grasp === null ? UNTESTED_WEIGHT : ROTATION_FLOOR + (1 - grasp);

    out.push({
      nodeId: node.id,
      title: node.title,
      mastery,
      grasp,
      lastQuiz: mastery?.lastQuiz ?? null,
      weight: base * staleness(mastery?.lastQuiz ?? null, now),
    });
  }

  return out;
}

/**
 * Same split as the per-card quiz: most of the test on the shakiest cards, a reserved slot for
 * something solid. A test made only of your worst material is demoralising and tells you nothing
 * about whether the rest has held.
 */
export function chooseCards(
  candidates: CardCandidate[],
  count = PLAN_QUIZ_CARDS,
): CardCandidate[] {
  if (candidates.length <= count) return [...candidates].sort((a, b) => b.weight - a.weight);

  const ranked = [...candidates].sort((a, b) => b.weight - a.weight);
  // Capped at count-1 for the same reason as chooseFocus: rounding otherwise consumes the
  // reserved rotation slot entirely at small counts.
  const drillCount = Math.max(1, Math.min(Math.ceil(count * 0.7), count - 1));
  const drill = ranked.slice(0, drillCount);

  // The reserved slots go to the SOLIDEST remaining cards, not merely the stalest. Ordering the
  // remainder by staleness quietly handed these slots to yet more weak material whenever weak
  // cards outnumbered the drill slots, which defeats the purpose of reserving them: they exist to
  // confirm that something already learned has held. Staleness only breaks ties.
  const rotate = ranked
    .slice(drillCount)
    .sort((a, b) => {
      const byGrasp = (b.grasp ?? 0.5) - (a.grasp ?? 0.5);
      if (byGrasp !== 0) return byGrasp;
      const at = a.lastQuiz ? new Date(a.lastQuiz).getTime() : 0;
      const bt = b.lastQuiz ? new Date(b.lastQuiz).getTime() : 0;
      return at - bt;
    })
    .slice(0, count - drillCount);

  return [...drill, ...rotate];
}

export interface PlanMasterySummary {
  /** Mean grasp across cards that have been quizzed. Null when none have. */
  overall: number | null;
  tested: number;
  eligible: number;
  totalUnits: number;
  weakest: CardCandidate[];
}

export function summarise(
  graph: AtlasGraph,
  masteries: MasteryMap,
  now = Date.now(),
): PlanMasterySummary {
  const cards = eligibleCards(graph, masteries, now);
  const graded = cards.filter((c) => c.grasp !== null);
  const overall =
    graded.length === 0
      ? null
      : graded.reduce((sum, c) => sum + (c.grasp ?? 0), 0) / graded.length;

  return {
    overall,
    tested: graded.length,
    eligible: cards.length,
    totalUnits: graph.nodes.filter((n) => n.type === "UNIT").length,
    weakest: [...graded].sort((a, b) => (a.grasp ?? 0) - (b.grasp ?? 0)).slice(0, 4),
  };
}

/**
 * Namespacing for question ids.
 *
 * Each card's questions are generated independently, so two cards will both happily return a
 * question called "q1". Marking and mastery updates both key on the id, so without a prefix the
 * answers to one card's question would be scored against another's.
 */
export const NS = "::";

export function namespaceId(nodeId: string, questionId: string): string {
  return `${nodeId}${NS}${questionId}`;
}

export function splitId(namespaced: string): { nodeId: string; questionId: string } {
  const at = namespaced.indexOf(NS);
  if (at === -1) return { nodeId: "", questionId: namespaced };
  return {
    nodeId: namespaced.slice(0, at),
    questionId: namespaced.slice(at + NS.length),
  };
}

/** Cache key for a plan-wide test, kept distinct from any card id. */
export function planQuizKey(planId: string): string {
  return `plan${NS}${planId}`;
}

export function nodesById(graph: AtlasGraph): Map<string, AtlasNode> {
  return new Map(graph.nodes.map((n) => [n.id, n]));
}
