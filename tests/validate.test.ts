import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateGraph } from "../src/schema/validate";
import type { Edge } from "../src/schema/atlas";

/**
 * The validator passing on a good graph proves almost nothing. What matters is that it REJECTS
 * the specific ways a generated graph goes wrong — so most of these tests are rejection tests.
 */

const golden = JSON.parse(
  readFileSync(resolve(process.cwd(), "fixtures/golden-bs-streaming.json"), "utf8"),
);

const codes = (r: ReturnType<typeof validateGraph>) => r.errors.map((e) => e.code);

/** A minimal well-formed graph: two prerequisites converging on one unit. */
function baseGraph() {
  const unit = (id: string, title: string) => ({
    id,
    type: "UNIT" as const,
    kind: "skill" as const,
    title,
    why: "because the goal depends on it",
    status: "ready" as const,
    estimate_min: 45,
    attempts: 0,
    exit_check: {
      evidence: "build" as const,
      prompt: "Produce the thing and show it running.",
      rubric: ["the thing runs without error", "the output matches the reference"],
    },
    known_pitfalls: [],
    resources: [],
    parent: null,
    provenance: { run_id: "r_test", confidence: 1 },
  });

  const edges: Edge[] = [
    { from: "a", to: "c", type: "requires", strength: 1 },
    { from: "b", to: "c", type: "requires", strength: 1 },
  ];

  return {
    atlas_version: "1" as const,
    id: "g_test",
    goal: {
      statement: "A goal statement long enough to pass",
      terminal_capability: "Do the thing that could not be done before",
      created: "2026-08-16",
    },
    nodes: [unit("a", "Alpha"), unit("b", "Bravo"), unit("c", "Charlie")],
    edges,
    events: [],
    mutations: [],
  };
}

describe("golden fixture", () => {
  it("validates", () => {
    const result = validateGraph(golden);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("converges — it is a graph, not a reading list", () => {
    const incoming = new Map<string, number>();
    for (const e of golden.edges) {
      if (e.type !== "requires") continue;
      incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
    }
    expect([...incoming.values()].filter((n) => n >= 2).length).toBeGreaterThanOrEqual(3);
  });

  it("flags oversized units as expansion candidates rather than errors", () => {
    const result = validateGraph(golden);
    expect(result.warnings.map((w) => w.code)).toContain("OVERSIZED");
    expect(result.ok).toBe(true);
  });
});

describe("rejects a syllabus wearing a DAG costume", () => {
  it("fails a purely linear chain", () => {
    const g = baseGraph();
    g.edges = [
      { from: "a", to: "b", type: "requires", strength: 1 },
      { from: "b", to: "c", type: "requires", strength: 1 },
    ];
    expect(codes(validateGraph(g))).toContain("NO_CONVERGENCE");
  });
});

describe("rejects ungradeable exit checks", () => {
  it.each([
    "understands the streaming model",
    "is familiar with checkpointing",
    "knows about watermarks",
    "is comfortable with the API",
    "grasps the volatility smile",
  ])("rejects rubric item: %s", (item) => {
    const g = baseGraph();
    g.nodes[0]!.exit_check.rubric = [item, "the output matches the reference"];
    expect(codes(validateGraph(g))).toContain("UNGRADEABLE");
  });

  it("accepts observable rubric items", () => {
    const g = baseGraph();
    g.nodes[0]!.exit_check.rubric = [
      "restart resumes from the committed offset",
      "row count matches the single-run baseline",
    ];
    expect(codes(validateGraph(g))).not.toContain("UNGRADEABLE");
  });

  it("rejects a single-item rubric at the schema level", () => {
    const g = baseGraph();
    (g.nodes[0]!.exit_check.rubric as string[]) = ["the thing runs"];
    expect(codes(validateGraph(g))).toContain("SHAPE");
  });
});

describe("acyclicity applies to the planning subgraph only", () => {
  it("rejects a cycle in requires", () => {
    const g = baseGraph();
    g.edges.push({ from: "c", to: "a", type: "requires", strength: 1 });
    expect(codes(validateGraph(g))).toContain("CYCLE");
  });

  it("rejects a cycle that mixes requires and then", () => {
    const g = baseGraph();
    g.edges.push({ from: "c", to: "a", type: "then", strength: 1 });
    expect(codes(validateGraph(g))).toContain("CYCLE");
  });

  it("allows an on_fail edge pointing back upstream — runtime may loop", () => {
    const g = baseGraph();
    g.edges.push({ from: "c", to: "a", type: "on_fail", strength: 1 });
    const result = validateGraph(g);
    expect(codes(result)).not.toContain("CYCLE");
    expect(result.ok).toBe(true);
  });
});

describe("edge integrity", () => {
  it("rejects an edge to a node that does not exist", () => {
    const g = baseGraph();
    g.edges.push({ from: "a", to: "ghost", type: "requires", strength: 1 });
    expect(codes(validateGraph(g))).toContain("DANGLING_EDGE");
  });

  it("rejects a self edge", () => {
    const g = baseGraph();
    g.edges.push({ from: "a", to: "a", type: "requires", strength: 1 });
    expect(codes(validateGraph(g))).toContain("SELF_EDGE");
  });

  it("rejects an 'if' edge that does not leave a DECISION", () => {
    const g = baseGraph();
    g.edges.push({ from: "a", to: "b", type: "if", strength: 1, condition: "websocket available" });
    expect(codes(validateGraph(g))).toContain("IF_SOURCE");
  });

  it("rejects a condition on a non-'if' edge", () => {
    const g = baseGraph();
    g.edges.push({ from: "a", to: "b", type: "requires", strength: 1, condition: "sometimes" });
    expect(codes(validateGraph(g))).toContain("STRAY_CONDITION");
  });
});

describe("recovery nodes", () => {
  it("rejects a recovery nothing can reach", () => {
    const g = baseGraph();
    g.nodes.push({
      id: "r1",
      type: "RECOVERY",
      title: "Orphan recovery",
      why: "it was invented with no way in",
      status: "ready",
      estimate_min: 30,
      diagnosis: "a diagnosis long enough to pass",
      remediation: ["do the first thing"],
      resources: [],
      provenance: { run_id: "r_test", confidence: 0.8 },
    } as never);
    expect(codes(validateGraph(g))).toContain("RECOVERY_UNREACHABLE");
  });

  it("accepts a recovery reached by on_fail", () => {
    const g = baseGraph();
    g.nodes.push({
      id: "r1",
      type: "RECOVERY",
      title: "Reachable recovery",
      why: "it hangs off a real failure",
      status: "ready",
      estimate_min: 30,
      diagnosis: "a diagnosis long enough to pass",
      remediation: ["do the first thing"],
      resources: [],
      provenance: { run_id: "r_test", confidence: 0.8 },
    } as never);
    g.edges.push({ from: "c", to: "r1", type: "on_fail", strength: 1 });
    expect(validateGraph(g).ok).toBe(true);
  });
});

describe("DECISION survives in the schema while its UI is deferred", () => {
  it("validates a decision node with conditional branches", () => {
    const g = baseGraph();
    g.nodes.push({
      id: "d1",
      type: "DECISION",
      title: "Transport choice",
      why: "the ingestion path depends on what the plan exposes",
      status: "ready",
      question: "Is the websocket available on your plan?",
      provenance: { run_id: "r_test", confidence: 0.9 },
    } as never);
    g.edges.push({ from: "d1", to: "b", type: "if", strength: 1, condition: "websocket available" });
    g.edges.push({ from: "d1", to: "a", type: "if", strength: 1, condition: "polling only" });
    expect(validateGraph(g).ok).toBe(true);
  });
});

describe("resources are never trusted from the model", () => {
  it("rejects a resource marked ok without a verification date", () => {
    const g = baseGraph();
    g.nodes[0]!.resources = [
      {
        url: "https://example.com/guide",
        kind: "docs",
        minutes: 20,
        cost: 0,
        verified: null,
        status: "ok",
      },
    ] as never;
    expect(codes(validateGraph(g))).toContain("SHAPE");
  });

  it("accepts an honestly unverified resource", () => {
    const g = baseGraph();
    g.nodes[0]!.resources = [
      {
        url: "https://example.com/guide",
        kind: "docs",
        minutes: 20,
        cost: 0,
        verified: null,
        status: "unverified",
      },
    ] as never;
    expect(validateGraph(g).ok).toBe(true);
  });
});
