import { describe, it, expect } from "vitest";
import { applyPatch, recomputeStatuses, Patch, PatchTargetError } from "../src/graph/mutate";
import { AtlasGraph } from "../src/schema/atlas";
import { validateGraph } from "../src/schema/validate";
import golden from "../fixtures/golden-bs-streaming.json";

/**
 * The patch layer is the one place a bad generation could destroy real progress, so these tests
 * pin the guarantees that stop it: patches never touch a status the learner earned, a prune never
 * orphans what came after it, and an unknown target fails loudly instead of silently doing nothing.
 */

const base = () => AtlasGraph.parse(golden);
const RUN = "r_test";

const draftUnit = {
  kind: "skill" as const,
  title: "A new prerequisite",
  why: "because the card above it cannot be attempted otherwise",
  estimate_min: 45,
  exit_check: {
    evidence: "build" as const,
    prompt: "Produce the thing and show it running.",
    rubric: ["the thing runs without error", "the output matches the reference"],
  },
  known_pitfalls: [],
};

describe("edit_node", () => {
  it("changes only the fields it names", () => {
    const graph = base();
    const target = graph.nodes.find((n) => n.type === "UNIT")!;
    const out = applyPatch(
      graph,
      Patch.parse({
        op: "edit_node",
        target: target.id,
        title: "A sharper title",
        reason: "the old title was vague",
      }),
      RUN,
    );

    const after = out.nodes.find((n) => n.id === target.id)!;
    expect(after.title).toBe("A sharper title");
    expect(after.why).toBe(target.why);
  });

  it("throws a clear error for a node that is not there", () => {
    expect(() =>
      applyPatch(
        base(),
        Patch.parse({ op: "edit_node", target: "n_ghost", title: "X Y Z", reason: "no such node" }),
        RUN,
      ),
    ).toThrow(PatchTargetError);
  });
});

describe("insert_prereq", () => {
  it("adds the node and wires it into the target", () => {
    const graph = base();
    const target = graph.nodes.find((n) => n.status === "ready" && n.type === "UNIT")!;
    const out = applyPatch(
      graph,
      Patch.parse({ op: "insert_prereq", target: target.id, node: draftUnit, reason: "it was missing" }),
      RUN,
    );

    expect(out.nodes).toHaveLength(graph.nodes.length + 1);
    const added = out.nodes.find((n) => n.title === draftUnit.title)!;
    expect(out.edges).toContainEqual(
      expect.objectContaining({ from: added.id, to: target.id, type: "requires" }),
    );
  });

  it("locks a previously-ready target, since it now waits on something unfinished", () => {
    const graph = base();
    const target = graph.nodes.find((n) => n.status === "ready" && n.type === "UNIT")!;
    const out = applyPatch(
      graph,
      Patch.parse({ op: "insert_prereq", target: target.id, node: draftUnit, reason: "it was missing" }),
      RUN,
    );
    expect(out.nodes.find((n) => n.id === target.id)!.status).toBe("locked");
  });

  it("leaves the result a valid graph", () => {
    const graph = base();
    const target = graph.nodes.find((n) => n.status === "ready" && n.type === "UNIT")!;
    const out = applyPatch(
      graph,
      Patch.parse({ op: "insert_prereq", target: target.id, node: draftUnit, reason: "it was missing" }),
      RUN,
    );
    expect(validateGraph(out).ok).toBe(true);
  });
});

describe("prune_node", () => {
  it("bridges across the gap so downstream cards are not orphaned", () => {
    const graph = base();
    // Pick a node that has both a prerequisite and a dependant.
    const middle = graph.nodes.find(
      (n) =>
        graph.edges.some((e) => e.to === n.id && e.type === "requires") &&
        graph.edges.some((e) => e.from === n.id && e.type === "requires"),
    )!;
    const ups = graph.edges.filter((e) => e.to === middle.id && e.type === "requires");
    const downs = graph.edges.filter((e) => e.from === middle.id && e.type === "requires");

    const out = applyPatch(
      graph,
      Patch.parse({ op: "prune_node", target: middle.id, reason: "redundant with another card" }),
      RUN,
    );

    expect(out.nodes.some((n) => n.id === middle.id)).toBe(false);
    for (const up of ups) {
      for (const down of downs) {
        expect(out.edges).toContainEqual(
          expect.objectContaining({ from: up.from, to: down.to, type: "requires" }),
        );
      }
    }
  });

  it("removes a recovery that hung off the pruned card", () => {
    const graph = base();
    const failEdge = graph.edges.find((e) => e.type === "on_fail")!;
    const out = applyPatch(
      graph,
      Patch.parse({ op: "prune_node", target: failEdge.from, reason: "no longer needed" }),
      RUN,
    );
    expect(out.nodes.some((n) => n.id === failEdge.to)).toBe(false);
    expect(out.edges.some((e) => e.to === failEdge.to)).toBe(false);
  });

  it("leaves no dangling edges behind", () => {
    const graph = base();
    const target = graph.nodes.find((n) => n.type === "UNIT")!;
    const out = applyPatch(
      graph,
      Patch.parse({ op: "prune_node", target: target.id, reason: "cut for length" }),
      RUN,
    );
    const ids = new Set(out.nodes.map((n) => n.id));
    expect(out.edges.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true);
  });
});

describe("recomputeStatuses", () => {
  it("never overwrites a status the learner earned", () => {
    const graph = base();
    const engaged = graph.nodes.filter((n) =>
      ["passed", "failed", "in_progress"].includes(n.status),
    );
    expect(engaged.length).toBeGreaterThan(0);

    const out = recomputeStatuses(graph);
    for (const n of engaged) {
      expect(out.nodes.find((x) => x.id === n.id)!.status).toBe(n.status);
    }
  });

  it("opens a card once every prerequisite has passed", () => {
    const graph = base();
    const allPassed: typeof graph = {
      ...graph,
      nodes: graph.nodes.map((n) => (n.status === "locked" ? n : { ...n, status: "passed" })),
    };
    const out = recomputeStatuses(allPassed);
    const stillLocked = out.nodes.filter((n) => n.status === "locked");
    for (const n of stillLocked) {
      const prereqs = out.edges.filter((e) => e.to === n.id && e.type === "requires");
      expect(prereqs.some((e) => out.nodes.find((x) => x.id === e.from)!.status !== "passed")).toBe(
        true,
      );
    }
  });
});

describe("the audit trail", () => {
  it("records the reason and an inverse for every patch", () => {
    const graph = base();
    const target = graph.nodes.find((n) => n.type === "UNIT")!;
    const out = applyPatch(
      graph,
      Patch.parse({ op: "edit_node", target: target.id, title: "New title", reason: "clarity" }),
      RUN,
    );

    const record = out.mutations.at(-1)!;
    expect(record.reason).toBe("clarity");
    expect(record.op).toBe("edit_node");
    expect(record.inverse).toBeTruthy();
    expect(out.events.at(-1)?.detail).toContain("edited");
  });

  it("keeps the prior node list, so a prune is reversible", () => {
    const graph = base();
    const target = graph.nodes.find((n) => n.type === "UNIT")!;
    const out = applyPatch(
      graph,
      Patch.parse({ op: "prune_node", target: target.id, reason: "cut for length" }),
      RUN,
    );
    const inverse = out.mutations.at(-1)!.inverse as { nodes: unknown[] };
    expect(inverse.nodes).toHaveLength(graph.nodes.length);
  });
});

describe("retitle_chapters", () => {
  it("replaces the stored names without touching the graph shape", () => {
    const graph = base();
    const out = applyPatch(
      graph,
      Patch.parse({
        op: "retitle_chapters",
        chapters: ["Groundwork", "The middle", "The proof"],
        reason: "the old names were generic",
      }),
      RUN,
    );
    expect(out.chapters).toEqual(["Groundwork", "The middle", "The proof"]);
    expect(out.nodes).toHaveLength(graph.nodes.length);
    expect(out.edges).toHaveLength(graph.edges.length);
  });
});

describe("patch validation", () => {
  it("rejects an ungradeable rubric on an inserted node", () => {
    expect(() =>
      Patch.parse({
        op: "insert_prereq",
        target: "n_x",
        node: { ...draftUnit, exit_check: { ...draftUnit.exit_check, rubric: ["only one item"] } },
        reason: "too few",
      }),
    ).toThrow();
  });

  it("rejects an unknown op outright", () => {
    expect(() => Patch.parse({ op: "delete_everything", reason: "nope" })).toThrow();
  });
});
