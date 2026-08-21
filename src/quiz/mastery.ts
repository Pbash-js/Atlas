/**
 * What Atlas remembers about how well you know each part of a card.
 *
 * Two things matter about the shape of this file.
 *
 * First, the store is an INTERFACE with a swappable implementation. The default keeps everything
 * in localStorage, but every method is async and keyed by node, so a server-backed or
 * cross-device store drops in through `setMasteryStore` without a single call site changing.
 * The async signatures are load-bearing even though localStorage is synchronous — they are what
 * make the swap invisible later.
 *
 * Second, strength is an exponential moving average rather than a plain accuracy ratio. A ratio
 * treats a question you missed six months ago exactly like one you missed just now, which makes
 * it useless for deciding what to drill. The EMA lets recent evidence dominate, so recovering
 * from a bad run is possible and a lapse on something previously solid actually registers.
 */

export interface ConceptMastery {
  concept: string;
  asked: number;
  correct: number;
  /** Consecutive correct answers; resets to 0 on a miss. */
  streak: number;
  lastSeen: string;
  /** 0..1, EMA over correctness. Starts at 0.5 — unknown, not assumed weak. */
  strength: number;
}

export interface NodeMastery {
  nodeId: string;
  concepts: ConceptMastery[];
  quizzes: number;
  lastQuiz: string | null;
}

export interface MasteryStore {
  load(nodeId: string): Promise<NodeMastery | null>;
  save(mastery: NodeMastery): Promise<void>;
  clear(nodeId: string): Promise<void>;
}

const KEY_PREFIX = "atlas.mastery.";

/** How fast recent answers displace older ones. 0.4 ≈ the last ~3 answers dominate. */
export const ALPHA = 0.4;
const INITIAL_STRENGTH = 0.5;

/** Strong concepts keep this much pull, so mastery never removes them from rotation entirely. */
export const ROTATION_FLOOR = 0.15;

/** Share of a quiz spent on the weakest concepts; the rest is rotation and new ground. */
export const DRILL_SHARE = 0.7;

export const localMasteryStore: MasteryStore = {
  async load(nodeId) {
    try {
      const raw = localStorage.getItem(KEY_PREFIX + nodeId);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as NodeMastery;
      return Array.isArray(parsed?.concepts) ? parsed : null;
    } catch {
      return null;
    }
  },
  async save(mastery) {
    try {
      localStorage.setItem(KEY_PREFIX + mastery.nodeId, JSON.stringify(mastery));
    } catch {
      // A browser refusing storage still lets the quiz run; it just will not remember.
    }
  },
  async clear(nodeId) {
    try {
      localStorage.removeItem(KEY_PREFIX + nodeId);
    } catch {
      // Nothing to do — clearing is best-effort by definition.
    }
  },
};

let active: MasteryStore = localMasteryStore;

/** The override hook: swap in a server-backed store without touching any call site. */
export function setMasteryStore(store: MasteryStore): void {
  active = store;
}

export function getMasteryStore(): MasteryStore {
  return active;
}

/** Reset to the built-in store. Mainly for tests, so one suite cannot leak into the next. */
export function resetMasteryStore(): void {
  active = localMasteryStore;
}

export function emptyMastery(nodeId: string): NodeMastery {
  return { nodeId, concepts: [], quizzes: 0, lastQuiz: null };
}

export interface Graded {
  concept: string;
  correct: boolean;
}

/** Fold one quiz's results into what was already known. Unseen concepts are created. */
export function applyResults(
  mastery: NodeMastery,
  graded: Graded[],
  now = new Date().toISOString(),
): NodeMastery {
  const byConcept = new Map(mastery.concepts.map((c) => [c.concept, { ...c }]));

  for (const { concept, correct } of graded) {
    const prior = byConcept.get(concept);
    const base = prior ?? {
      concept,
      asked: 0,
      correct: 0,
      streak: 0,
      lastSeen: now,
      strength: INITIAL_STRENGTH,
    };

    byConcept.set(concept, {
      concept,
      asked: base.asked + 1,
      correct: base.correct + (correct ? 1 : 0),
      streak: correct ? base.streak + 1 : 0,
      lastSeen: now,
      strength: base.strength * (1 - ALPHA) + (correct ? 1 : 0) * ALPHA,
    });
  }

  return {
    ...mastery,
    concepts: [...byConcept.values()],
    quizzes: mastery.quizzes + 1,
    lastQuiz: now,
  };
}

/** Higher means more deserving of a question. Never reaches zero — see ROTATION_FLOOR. */
export function weightOf(c: ConceptMastery, now = Date.now()): number {
  const days = Math.max(0, (now - new Date(c.lastSeen).getTime()) / 86_400_000);
  // Doubles after roughly a fortnight untouched, so solid-but-stale work resurfaces.
  const staleness = 1 + Math.min(days / 14, 1);
  return (ROTATION_FLOOR + (1 - c.strength)) * staleness;
}

export interface Focus {
  /** Concepts to drill hardest, weakest first. */
  drill: string[];
  /** Concepts kept in rotation to confirm they are still solid. */
  rotate: string[];
}

/**
 * Choose what the next quiz should cover.
 *
 * The split is the whole point: most questions go to the weakest material, but a reserved share
 * always goes to concepts that are NOT weak. Drilling only failures would let mastered material
 * rot silently and would make every quiz a demoralising parade of your worst subjects.
 */
export function chooseFocus(mastery: NodeMastery, count: number, now = Date.now()): Focus {
  if (mastery.concepts.length === 0) return { drill: [], rotate: [] };

  const ranked = [...mastery.concepts].sort((a, b) => weightOf(b, now) - weightOf(a, now));
  // Cap drilling at count-1 so a rotation slot genuinely survives. Without the cap, rounding ate
  // it whole at small counts — ceil(3 * 0.7) is 3, which left nothing to rotate at all.
  const drillCount = Math.min(
    ranked.length,
    Math.max(1, Math.min(Math.ceil(count * DRILL_SHARE), count - 1)),
  );

  const drill = ranked.slice(0, drillCount);
  const remaining = ranked.slice(drillCount);

  // Rotation slots go to the STRONGEST remaining concepts, with staleness only as a tie-break.
  // Ordering by staleness alone handed these slots to more weak material whenever weak concepts
  // outnumbered the drill slots — which is exactly when the reserved slot matters most.
  const rotate = [...remaining]
    .sort((a, b) => {
      const byStrength = b.strength - a.strength;
      if (byStrength !== 0) return byStrength;
      return new Date(a.lastSeen).getTime() - new Date(b.lastSeen).getTime();
    })
    .slice(0, Math.max(0, count - drillCount));

  return { drill: drill.map((c) => c.concept), rotate: rotate.map((c) => c.concept) };
}

export const WEAK_BELOW = 0.55;
export const STRONG_AT_OR_ABOVE = 0.8;

export function weakConcepts(mastery: NodeMastery): ConceptMastery[] {
  return mastery.concepts
    .filter((c) => c.strength < WEAK_BELOW)
    .sort((a, b) => a.strength - b.strength);
}

export function strongConcepts(mastery: NodeMastery): ConceptMastery[] {
  return mastery.concepts
    .filter((c) => c.strength >= STRONG_AT_OR_ABOVE)
    .sort((a, b) => b.strength - a.strength);
}

/** Overall grasp of a card, for the panel summary. Null when nothing has been asked yet. */
export function overallStrength(mastery: NodeMastery): number | null {
  if (mastery.concepts.length === 0) return null;
  const total = mastery.concepts.reduce((sum, c) => sum + c.strength, 0);
  return total / mastery.concepts.length;
}
