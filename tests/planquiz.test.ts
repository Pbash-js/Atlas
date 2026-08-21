import { describe, it, expect } from "vitest";
import {
  eligibleCards,
  chooseCards,
  summarise,
  namespaceId,
  splitId,
  planQuizKey,
  type MasteryMap,
} from "../src/quiz/planquiz";
import { applyResults, emptyMastery, type NodeMastery } from "../src/quiz/mastery";
import { AtlasGraph } from "../src/schema/atlas";
import golden from "../fixtures/golden-bs-streaming.json";

/**
 * The plan-wide test must never quiz someone on work they have not reached — that is the rule
 * these tests exist to hold. The rest pins the card-selection split and the id namespacing that
 * stops one card's answers being scored against another's.
 */

const base = () => AtlasGraph.parse(golden);

function masteryWith(strength: number, lastQuiz?: string): NodeMastery {
  return {
    nodeId: "x",
    quizzes: 2,
    lastQuiz: lastQuiz ?? new Date().toISOString(),
    concepts: [
      { concept: "c", asked: 3, correct: 2, streak: 1, lastSeen: new Date().toISOString(), strength },
    ],
  };
}

describe("eligibility", () => {
  it("never includes a locked card", () => {
    const graph = base();
    const cards = eligibleCards(graph, new Map());
    const locked = graph.nodes.filter((n) => n.status === "locked").map((n) => n.id);
    expect(locked.length).toBeGreaterThan(0);
    for (const id of locked) {
      expect(cards.some((c) => c.nodeId === id)).toBe(false);
    }
  });

  it("includes passed cards even with no quiz history", () => {
    const graph = base();
    const cards = eligibleCards(graph, new Map());
    const passed = graph.nodes.filter((n) => n.status === "passed");
    expect(passed.length).toBeGreaterThan(0);
    for (const n of passed) {
      expect(cards.some((c) => c.nodeId === n.id)).toBe(true);
    }
  });

  it("includes an unpassed card once it has been quizzed", () => {
    const graph = base();
    const ready = graph.nodes.find((n) => n.status === "ready")!;
    const withHistory: MasteryMap = new Map([[ready.id, masteryWith(0.4)]]);
    expect(eligibleCards(graph, withHistory).some((c) => c.nodeId === ready.id)).toBe(true);
    expect(eligibleCards(graph, new Map()).some((c) => c.nodeId === ready.id)).toBe(false);
  });

  it("excludes decision nodes, which have nothing to be quizzed on", () => {
    const graph = base();
    const withDecision: typeof graph = {
      ...graph,
      nodes: [
        ...graph.nodes,
        {
          id: "d1",
          type: "DECISION",
          title: "A fork",
          why: "the route depends on what is available",
          status: "passed",
          question: "Which way?",
          provenance: { run_id: "r", confidence: 0.9 },
        },
      ],
    };
    expect(eligibleCards(withDecision, new Map()).some((c) => c.nodeId === "d1")).toBe(false);
  });

  it("reports an untested card as grasp null rather than zero", () => {
    const graph = base();
    const card = eligibleCards(graph, new Map())[0]!;
    expect(card.grasp).toBeNull();
  });
});

describe("weighting and selection", () => {
  const graph = base();
  const passed = graph.nodes.filter((n) => n.status === "passed");

  it("ranks a weak card above a strong one", () => {
    const m: MasteryMap = new Map([
      [passed[0]!.id, masteryWith(0.15)],
      [passed[1]!.id, masteryWith(0.95)],
    ]);
    const cards = eligibleCards(graph, m);
    const weak = cards.find((c) => c.nodeId === passed[0]!.id)!;
    const strong = cards.find((c) => c.nodeId === passed[1]!.id)!;
    expect(weak.weight).toBeGreaterThan(strong.weight);
  });

  it("resurfaces a strong card that has gone stale", () => {
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const m: MasteryMap = new Map([
      [passed[0]!.id, masteryWith(0.9)],
      [passed[1]!.id, { ...masteryWith(0.9, old), lastQuiz: old }],
    ]);
    const cards = eligibleCards(graph, m);
    const fresh = cards.find((c) => c.nodeId === passed[0]!.id)!;
    const stale = cards.find((c) => c.nodeId === passed[1]!.id)!;
    expect(stale.weight).toBeGreaterThan(fresh.weight);
  });

  it("keeps a strong card in the selection alongside the weak ones", () => {
    const m: MasteryMap = new Map(
      passed.map((n, i) => [n.id, masteryWith(i === 0 ? 0.95 : 0.1)] as const),
    );
    const chosen = chooseCards(eligibleCards(graph, m), 4);
    expect(chosen.some((c) => c.nodeId === passed[0]!.id)).toBe(true);
  });

  it("never returns more cards than asked for, nor duplicates", () => {
    const chosen = chooseCards(eligibleCards(graph, new Map()), 4);
    expect(chosen.length).toBeLessThanOrEqual(4);
    expect(new Set(chosen.map((c) => c.nodeId)).size).toBe(chosen.length);
  });

  it("returns everything it has when the pool is smaller than the ask", () => {
    const cards = eligibleCards(graph, new Map()).slice(0, 2);
    expect(chooseCards(cards, 4)).toHaveLength(2);
  });
});

describe("summary", () => {
  it("is null overall until something has actually been quizzed", () => {
    expect(summarise(base(), new Map()).overall).toBeNull();
  });

  it("averages only the cards that have been quizzed", () => {
    const graph = base();
    const passed = graph.nodes.filter((n) => n.status === "passed");
    const m: MasteryMap = new Map([
      [passed[0]!.id, masteryWith(0.4)],
      [passed[1]!.id, masteryWith(0.8)],
    ]);
    const s = summarise(graph, m);
    expect(s.tested).toBe(2);
    expect(s.overall).toBeCloseTo(0.6, 5);
    expect(s.eligible).toBeGreaterThan(2);
  });

  it("lists the weakest cards first", () => {
    const graph = base();
    const passed = graph.nodes.filter((n) => n.status === "passed");
    const m: MasteryMap = new Map([
      [passed[0]!.id, masteryWith(0.9)],
      [passed[1]!.id, masteryWith(0.2)],
    ]);
    expect(summarise(graph, m).weakest[0]?.nodeId).toBe(passed[1]!.id);
  });
});

describe("question id namespacing", () => {
  it("round-trips a card id and a question id", () => {
    expect(splitId(namespaceId("n_abc", "q1"))).toEqual({ nodeId: "n_abc", questionId: "q1" });
  });

  it("keeps two cards' identically-named questions distinct", () => {
    expect(namespaceId("n_a", "q1")).not.toBe(namespaceId("n_b", "q1"));
  });

  it("survives a node id that itself contains separators", () => {
    const id = namespaceId("n_a::weird", "q1");
    expect(splitId(id).nodeId).toBe("n_a");
  });

  it("degrades to an empty owner for an un-namespaced id rather than guessing", () => {
    expect(splitId("q1")).toEqual({ nodeId: "", questionId: "q1" });
  });

  it("gives the plan test a cache key that cannot collide with a card", () => {
    const key = planQuizKey("atlas_bs_streaming");
    expect(key.startsWith("plan::")).toBe(true);
    expect(base().nodes.some((n) => n.id === key)).toBe(false);
  });
});

describe("results feed back per card", () => {
  it("keeps each card's mastery separate when grouped by namespaced id", () => {
    const results = [
      { id: namespaceId("n_a", "q1"), concept: "alpha", correct: true },
      { id: namespaceId("n_b", "q1"), concept: "beta", correct: false },
    ];

    const grouped = new Map<string, { concept: string; correct: boolean }[]>();
    for (const r of results) {
      const owner = splitId(r.id).nodeId;
      grouped.set(owner, [...(grouped.get(owner) ?? []), { concept: r.concept, correct: r.correct }]);
    }

    const a = applyResults(emptyMastery("n_a"), grouped.get("n_a")!);
    const b = applyResults(emptyMastery("n_b"), grouped.get("n_b")!);

    expect(a.concepts).toHaveLength(1);
    expect(a.concepts[0]!.strength).toBeGreaterThan(0.5);
    expect(b.concepts[0]!.strength).toBeLessThan(0.5);
  });
});
