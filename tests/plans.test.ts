import { describe, it, expect, beforeEach } from "vitest";

/**
 * store/plans.ts calls the browser's localStorage, which the default Node test environment does
 * not provide (no jsdom/happy-dom in this project — see package.json). A tiny in-memory stub is
 * cheaper and more honest than pulling in a DOM environment for one file: these tests exercise
 * the store's own logic, not real persistence, and the stub gives exactly the Storage surface
 * the store actually calls.
 */
class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string) {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  clear() {
    this.data.clear();
  }
}

(globalThis as { localStorage: Storage }).localStorage = new MemoryStorage() as unknown as Storage;

const { addManualResource, setNodeResources, savePlan, listPlans } = await import(
  "../src/store/plans"
);
const { AtlasGraph } = await import("../src/schema/atlas");
const golden = (await import("../fixtures/golden-bs-streaming.json")).default;

beforeEach(() => {
  localStorage.clear();
});

const baseGraph = () => AtlasGraph.parse(golden);

describe("addManualResource", () => {
  it("appends to whatever the node already had, rather than replacing it", () => {
    const graph = baseGraph();
    const nodeId = graph.nodes.find((n) => n.type === "UNIT")!.id;

    const withFirst = setNodeResources(graph, nodeId, [
      { url: "https://a.example/1", title: "A", kind: "docs", minutes: 10, cost: 0, verified: "2026-08-01", status: "ok" },
    ]);
    const withSecond = addManualResource(withFirst, nodeId, {
      url: "https://b.example/2",
      title: "B",
      kind: "text",
      minutes: 5,
      cost: 0,
      verified: "2026-08-18",
      status: "ok",
    });

    const node = withSecond.nodes.find((n) => n.id === nodeId);
    expect(node?.type === "UNIT" && node.resources.map((r) => r.url)).toEqual([
      "https://a.example/1",
      "https://b.example/2",
    ]);
  });

  it("is a no-op when the same URL (normalised) is already there", () => {
    const graph = baseGraph();
    const nodeId = graph.nodes.find((n) => n.type === "UNIT")!.id;

    const once = addManualResource(graph, nodeId, {
      url: "https://example.com/guide",
      title: "Guide",
      kind: "docs",
      minutes: 10,
      cost: 0,
      verified: "2026-08-18",
      status: "ok",
    });
    const twice = addManualResource(once, nodeId, {
      url: "https://www.example.com/guide/",
      title: "Guide again",
      kind: "docs",
      minutes: 10,
      cost: 0,
      verified: "2026-08-18",
      status: "ok",
    });

    const node = twice.nodes.find((n) => n.id === nodeId);
    expect(node?.type === "UNIT" && node.resources).toHaveLength(1);
  });

  it("never touches a DECISION node, which has no resources field", () => {
    const graph = baseGraph();
    const withDecision: typeof graph = {
      ...graph,
      nodes: [
        ...graph.nodes,
        {
          id: "d1",
          type: "DECISION",
          title: "A choice",
          why: "because sometimes the path forks",
          status: "ready",
          question: "Which way?",
          provenance: { run_id: "r", confidence: 0.8 },
        },
      ],
    };

    const out = addManualResource(withDecision, "d1", {
      url: "https://example.com/x",
      title: "X",
      kind: "text",
      minutes: 5,
      cost: 0,
      verified: "2026-08-18",
      status: "ok",
    });

    expect(out).toBe(withDecision);
  });

  it("logs a resource_swapped event distinguishing the manual hand-off from a Librarian search", () => {
    const graph = baseGraph();
    const nodeId = graph.nodes.find((n) => n.type === "UNIT")!.id;

    const out = addManualResource(graph, nodeId, {
      url: "https://example.com/x",
      title: "X",
      kind: "text",
      minutes: 5,
      cost: 0,
      verified: "2026-08-18",
      status: "ok",
    });

    const event = out.events.at(-1);
    expect(event?.type).toBe("resource_swapped");
    expect(event?.detail).toContain("Google AI Mode");
  });

  it("persists through savePlan/listPlans, matching every other store mutation", () => {
    const graph = baseGraph();
    savePlan(graph);
    const nodeId = graph.nodes.find((n) => n.type === "UNIT")!.id;

    addManualResource(graph, nodeId, {
      url: "https://example.com/x",
      title: "X",
      kind: "text",
      minutes: 5,
      cost: 0,
      verified: "2026-08-18",
      status: "ok",
    });

    const reloaded = listPlans().find((p) => p.id === graph.id);
    const node = reloaded?.graph.nodes.find((n) => n.id === nodeId);
    expect(node?.type === "UNIT" && node.resources.some((r) => r.url === "https://example.com/x")).toBe(
      true,
    );
  });
});
