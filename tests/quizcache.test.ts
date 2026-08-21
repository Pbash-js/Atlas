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
  fingerprintOf,
  localQuizCache,
  getQuizCache,
  setQuizCache,
  resetQuizCache,
  newEntry,
  isUsable,
} = await import("../src/quiz/cache");
const { applyResults, emptyMastery } = await import("../src/quiz/mastery");

type QuizCache = import("../src/quiz/cache").QuizCache;
type UnitNode = import("../src/schema/atlas").UnitNode;
type Question = import("../src/quiz/types").Question;

beforeEach(() => localStorage.clear());
afterEach(() => resetQuizCache());

const node = (over: Partial<UnitNode> = {}): UnitNode => ({
  id: "n_x",
  type: "UNIT",
  kind: "skill",
  title: "Checkpointing",
  why: "a restart must not double-count ticks in the pricing job",
  status: "ready",
  estimate_min: 90,
  attempts: 0,
  exit_check: {
    evidence: "build",
    prompt: "Kill the stream mid-batch and restart with no duplicates.",
    rubric: ["checkpointLocation is set", "row count matches the baseline"],
  },
  known_pitfalls: [],
  resources: [],
  parent: null,
  provenance: { run_id: "r", confidence: 0.7 },
  ...over,
});

const questions: Question[] = [
  {
    id: "q1",
    kind: "mcq",
    concept: "checkpoint location",
    prompt: "Where does the offset live between runs?",
    options: ["the sink", "checkpointLocation", "the driver", "the shell"],
    answer_index: 1,
    expected: "",
  },
];

describe("the fingerprint decides when a cached quiz is stale", () => {
  it("is stable for the same card and the same mastery", () => {
    const m = emptyMastery("n_x");
    expect(fingerprintOf(node(), m)).toBe(fingerprintOf(node(), m));
  });

  it("changes when the card's exit check is rewritten", () => {
    const m = emptyMastery("n_x");
    const edited = node({
      exit_check: {
        evidence: "explain",
        prompt: "Explain how the offset survives a restart.",
        rubric: ["names the committed offset", "names the checkpoint directory"],
      },
    });
    expect(fingerprintOf(edited, m)).not.toBe(fingerprintOf(node(), m));
  });

  it("changes when the card's title or why is edited", () => {
    const m = emptyMastery("n_x");
    expect(fingerprintOf(node({ title: "Something else entirely" }), m)).not.toBe(
      fingerprintOf(node(), m),
    );
  });

  it("CHANGES after a quiz is submitted, so adaptivity is never frozen", () => {
    const before = emptyMastery("n_x");
    const after = applyResults(before, [{ concept: "checkpoint location", correct: false }]);
    expect(fingerprintOf(node(), after)).not.toBe(fingerprintOf(node(), before));
  });

  it("ignores float noise, so a cache written moments ago still hits", () => {
    const base = applyResults(emptyMastery("n_x"), [{ concept: "c", correct: true }]);
    const jittered = {
      ...base,
      concepts: [{ ...base.concepts[0]!, strength: base.concepts[0]!.strength + 0.0001 }],
    };
    expect(fingerprintOf(node(), jittered)).toBe(fingerprintOf(node(), base));
  });

  it("does not depend on the order concepts happen to be stored in", () => {
    const a = applyResults(emptyMastery("n_x"), [
      { concept: "alpha", correct: true },
      { concept: "beta", correct: false },
    ]);
    const reversed = { ...a, concepts: [...a.concepts].reverse() };
    expect(fingerprintOf(node(), reversed)).toBe(fingerprintOf(node(), a));
  });
});

describe("isUsable", () => {
  it("accepts an entry whose fingerprint still matches", () => {
    expect(isUsable(newEntry("n_x", "fp1", questions), "fp1")).toBe(true);
  });

  it("rejects a mismatched fingerprint and a missing entry alike", () => {
    expect(isUsable(newEntry("n_x", "fp1", questions), "fp2")).toBe(false);
    expect(isUsable(null, "fp1")).toBe(false);
  });
});

describe("the local cache", () => {
  it("round-trips questions and in-progress answers", async () => {
    await localQuizCache.save(newEntry("n_x", "fp1", questions, { q1: "1" }));
    const back = await localQuizCache.load("n_x");
    expect(back?.questions).toHaveLength(1);
    expect(back?.answers).toEqual({ q1: "1" });
  });

  it("returns null for a card with nothing saved", async () => {
    expect(await localQuizCache.load("nope")).toBeNull();
  });

  it("clears on request", async () => {
    await localQuizCache.save(newEntry("n_x", "fp1", questions));
    await localQuizCache.clear("n_x");
    expect(await localQuizCache.load("n_x")).toBeNull();
  });

  it("discards an entry written by an older cache version", async () => {
    const stale = { ...newEntry("n_x", "fp1", questions), version: 0 };
    localStorage.setItem("atlas.quiz.n_x", JSON.stringify(stale));
    expect(await localQuizCache.load("n_x")).toBeNull();
  });

  it("discards an entry whose questions no longer parse", async () => {
    const broken = {
      ...newEntry("n_x", "fp1", questions),
      questions: [{ id: "q1", kind: "mcq", concept: "c", prompt: "too few options", options: ["a"], answer_index: 0, expected: "" }],
    };
    localStorage.setItem("atlas.quiz.n_x", JSON.stringify(broken));
    expect(await localQuizCache.load("n_x")).toBeNull();
  });

  it("survives unparseable junk in storage", async () => {
    localStorage.setItem("atlas.quiz.n_x", "{not json");
    expect(await localQuizCache.load("n_x")).toBeNull();
  });

  it("does not throw when storage refuses to write", async () => {
    const broken = vi.spyOn(globalThis.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    await expect(localQuizCache.save(newEntry("n_x", "fp1", questions))).resolves.toBeUndefined();
    broken.mockRestore();
  });
});

describe("the cache is swappable", () => {
  it("routes through an injected cache instead of localStorage", async () => {
    const load = vi.fn().mockResolvedValue(null);
    const save = vi.fn().mockResolvedValue(undefined);
    const fake: QuizCache = { load, save, clear: vi.fn().mockResolvedValue(undefined) };

    setQuizCache(fake);
    await getQuizCache().load("n_x");
    await getQuizCache().save(newEntry("n_x", "fp1", questions));

    expect(load).toHaveBeenCalledWith("n_x");
    expect(save).toHaveBeenCalledOnce();
    expect(localStorage.getItem("atlas.quiz.n_x")).toBeNull();
  });
});
