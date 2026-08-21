import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(k: string) {
    return this.data.has(k) ? this.data.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
  clear() {
    this.data.clear();
  }
}
(globalThis as { localStorage: Storage }).localStorage = new MemoryStorage() as unknown as Storage;

const {
  applyResults,
  chooseFocus,
  emptyMastery,
  weightOf,
  weakConcepts,
  strongConcepts,
  overallStrength,
  localMasteryStore,
  getMasteryStore,
  setMasteryStore,
  resetMasteryStore,
  ROTATION_FLOOR,
} = await import("../src/quiz/mastery");

type MasteryStore = import("../src/quiz/mastery").MasteryStore;
type NodeMastery = import("../src/quiz/mastery").NodeMastery;

beforeEach(() => localStorage.clear());
afterEach(() => resetMasteryStore());

const concept = (name: string, strength: number, lastSeen = new Date().toISOString()) => ({
  concept: name,
  asked: 4,
  correct: Math.round(strength * 4),
  streak: 0,
  lastSeen,
  strength,
});

describe("applyResults", () => {
  it("creates a concept the first time it is seen", () => {
    const out = applyResults(emptyMastery("n1"), [{ concept: "watermarks", correct: true }]);
    expect(out.concepts).toHaveLength(1);
    expect(out.concepts[0]!.asked).toBe(1);
    expect(out.quizzes).toBe(1);
  });

  it("moves strength up on a correct answer and down on a miss", () => {
    const start = emptyMastery("n1");
    const up = applyResults(start, [{ concept: "c", correct: true }]);
    const down = applyResults(start, [{ concept: "c", correct: false }]);
    expect(up.concepts[0]!.strength).toBeGreaterThan(0.5);
    expect(down.concepts[0]!.strength).toBeLessThan(0.5);
  });

  it("weights recent evidence over old, so a comeback is possible", () => {
    let m = emptyMastery("n1");
    for (let i = 0; i < 5; i++) m = applyResults(m, [{ concept: "c", correct: false }]);
    const bottom = m.concepts[0]!.strength;
    for (let i = 0; i < 3; i++) m = applyResults(m, [{ concept: "c", correct: true }]);

    expect(bottom).toBeLessThan(0.1);
    // A plain accuracy ratio would still read 3/8 here; the EMA recognises the recovery.
    expect(m.concepts[0]!.strength).toBeGreaterThan(0.5);
    expect(m.concepts[0]!.correct / m.concepts[0]!.asked).toBeLessThan(0.5);
  });

  it("resets the streak on a miss but keeps the history", () => {
    let m = emptyMastery("n1");
    m = applyResults(m, [{ concept: "c", correct: true }]);
    m = applyResults(m, [{ concept: "c", correct: true }]);
    expect(m.concepts[0]!.streak).toBe(2);
    m = applyResults(m, [{ concept: "c", correct: false }]);
    expect(m.concepts[0]!.streak).toBe(0);
    expect(m.concepts[0]!.asked).toBe(3);
  });
});

describe("weighting", () => {
  it("ranks a weak concept above a strong one", () => {
    expect(weightOf(concept("weak", 0.2))).toBeGreaterThan(weightOf(concept("strong", 0.95)));
  });

  it("never drops a mastered concept to zero weight", () => {
    expect(weightOf(concept("perfect", 1))).toBeGreaterThanOrEqual(ROTATION_FLOOR);
  });

  it("resurfaces solid work that has gone stale", () => {
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    expect(weightOf(concept("stale", 0.9, old))).toBeGreaterThan(weightOf(concept("fresh", 0.9)));
  });
});

describe("chooseFocus", () => {
  const mastery = (): NodeMastery => ({
    nodeId: "n1",
    quizzes: 3,
    lastQuiz: new Date().toISOString(),
    concepts: [
      concept("very weak", 0.1),
      concept("weak", 0.3),
      concept("middling", 0.6),
      concept("solid", 0.9),
      concept("mastered", 0.98),
    ],
  });

  it("drills the weakest material first", () => {
    const { drill } = chooseFocus(mastery(), 5);
    expect(drill[0]).toBe("very weak");
    expect(drill).toContain("weak");
  });

  it("still keeps strong concepts in rotation", () => {
    const { drill, rotate } = chooseFocus(mastery(), 5);
    const covered = [...drill, ...rotate];
    const strong = covered.filter((c) => c === "solid" || c === "mastered");
    expect(strong.length).toBeGreaterThan(0);
  });

  it("reserves the rotation slot for solid work even when weak concepts outnumber it", () => {
    // Five weak, one strong, asking for three: the two drill slots take the weakest, and the one
    // rotation slot must still go to the strong concept rather than to a fourth weak one.
    const lopsided: NodeMastery = {
      nodeId: "n1",
      quizzes: 4,
      lastQuiz: new Date().toISOString(),
      concepts: [
        concept("w1", 0.1),
        concept("w2", 0.12),
        concept("w3", 0.15),
        concept("w4", 0.18),
        concept("w5", 0.2),
        concept("solid", 0.95),
      ],
    };

    const { rotate } = chooseFocus(lopsided, 3);
    expect(rotate).toContain("solid");
  });

  it("never asks for more concepts than it has", () => {
    const { drill, rotate } = chooseFocus(mastery(), 5);
    expect(drill.length + rotate.length).toBeLessThanOrEqual(5);
    expect(new Set([...drill, ...rotate]).size).toBe(drill.length + rotate.length);
  });

  it("returns nothing to focus on before any quiz has been taken", () => {
    expect(chooseFocus(emptyMastery("n1"), 5)).toEqual({ drill: [], rotate: [] });
  });
});

describe("classification", () => {
  const m: NodeMastery = {
    nodeId: "n1",
    quizzes: 2,
    lastQuiz: null,
    concepts: [concept("bad", 0.2), concept("ok", 0.7), concept("great", 0.9)],
  };

  it("splits weak from strong and leaves the middle out of both", () => {
    expect(weakConcepts(m).map((c) => c.concept)).toEqual(["bad"]);
    expect(strongConcepts(m).map((c) => c.concept)).toEqual(["great"]);
  });

  it("averages to an overall grasp, and is null before anything is asked", () => {
    expect(overallStrength(m)).toBeCloseTo(0.6, 5);
    expect(overallStrength(emptyMastery("n1"))).toBeNull();
  });
});

describe("the store is swappable", () => {
  it("round-trips through the default localStorage store", async () => {
    const m = applyResults(emptyMastery("n1"), [{ concept: "c", correct: true }]);
    await localMasteryStore.save(m);
    const back = await localMasteryStore.load("n1");
    expect(back?.concepts[0]?.concept).toBe("c");
  });

  it("returns null for a node it has never seen", async () => {
    expect(await localMasteryStore.load("nope")).toBeNull();
  });

  it("routes every call through an injected store instead", async () => {
    const load = vi.fn().mockResolvedValue(null);
    const save = vi.fn().mockResolvedValue(undefined);
    const fake: MasteryStore = { load, save, clear: vi.fn().mockResolvedValue(undefined) };

    setMasteryStore(fake);
    await getMasteryStore().load("n1");
    await getMasteryStore().save(emptyMastery("n1"));

    expect(load).toHaveBeenCalledWith("n1");
    expect(save).toHaveBeenCalledOnce();
    // The injected store took over completely — nothing leaked to localStorage.
    expect(localStorage.getItem("atlas.mastery.n1")).toBeNull();
  });

  it("survives a store that cannot write, rather than throwing at the caller", async () => {
    // Node has no global Storage class, so spy on the stub instance standing in for it.
    const broken = vi.spyOn(globalThis.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    await expect(localMasteryStore.save(emptyMastery("n1"))).resolves.toBeUndefined();
    broken.mockRestore();
  });
});
