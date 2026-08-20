import { describe, it, expect } from "vitest";
import { toResources, buildPrompt, findResources } from "../src/llm/librarian";
import { testConnection, QuotaError, type ReasoningModel } from "../src/llm/model";
import type { UnitNode } from "../src/schema/atlas";

/**
 * The Librarian's job is to never present an invented URL as a checked one. These tests pin the
 * verified/unverified boundary and the de-duplication, since those are what stand between the
 * panel and a graph full of dead links.
 */

const node: UnitNode = {
  id: "n_x",
  type: "UNIT",
  kind: "skill",
  title: "Structured Streaming checkpointing",
  why: "A pricing job that double-counts after a restart is untrustworthy.",
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
};

const reply = (resources: unknown) => JSON.stringify({ resources });

describe("grounding decides verified vs unverified", () => {
  const body = reply([
    { url: "https://example.com/guide", title: "A guide", kind: "docs", minutes: 40, cost: 0 },
    { url: "https://invented.example/nope", title: "Recalled", kind: "text", minutes: 20, cost: 0 },
  ]);

  it("marks a cited URL as verified", () => {
    const out = toResources(body, [{ url: "https://example.com/guide" }], "2026-08-18");
    const cited = out.find((r) => r.url.includes("example.com/guide"));
    expect(cited?.status).toBe("ok");
    expect(cited?.verified).toBe("2026-08-18");
  });

  it("marks an uncited URL as unverified rather than dropping it", () => {
    const out = toResources(body, [{ url: "https://example.com/guide" }]);
    const uncited = out.find((r) => r.url.includes("invented.example"));
    expect(uncited?.status).toBe("unverified");
    expect(uncited?.verified).toBeNull();
  });

  it("treats everything as unverified when there are no citations at all", () => {
    const out = toResources(body, []);
    expect(out.every((r) => r.status === "unverified")).toBe(true);
  });

  it("matches citations despite trailing slashes, www and tracking params", () => {
    const out = toResources(
      reply([{ url: "https://www.example.com/guide/", title: "Guide", kind: "docs", minutes: 10, cost: 0 }]),
      [{ url: "https://example.com/guide?utm_source=reddit" }],
    );
    expect(out[0]?.status).toBe("ok");
  });
});

describe("shaping", () => {
  it("de-duplicates the same resource returned twice", () => {
    const out = toResources(
      reply([
        { url: "https://example.com/a", title: "Alpha", kind: "docs", minutes: 10, cost: 0 },
        { url: "https://example.com/a/", title: "Alpha again", kind: "text", minutes: 12, cost: 0 },
      ]),
      [],
    );
    expect(out).toHaveLength(1);
  });

  it("folds the community verdict into the title so the panel shows why it was picked", () => {
    const out = toResources(
      reply([
        {
          url: "https://example.com/a",
          title: "The Book",
          kind: "text",
          minutes: 300,
          cost: 0,
          verdict: "repeatedly recommended on r/rust",
        },
      ]),
      [],
    );
    expect(out[0]?.title).toBe("The Book — repeatedly recommended on r/rust");
  });

  it("rejects a reply whose URL is not a URL", () => {
    expect(() =>
      toResources(reply([{ url: "not-a-url", title: "Xylo", kind: "docs", minutes: 5, cost: 0 }]), []),
    ).toThrow();
  });

  it("accepts an empty result rather than inventing filler", () => {
    expect(toResources(reply([]), [])).toEqual([]);
  });
});

describe("prompt", () => {
  it("carries the goal, the step and the rubric so the search is specific", () => {
    const prompt = buildPrompt({ node, goalStatement: "Price options on a live stream" });
    expect(prompt).toContain("Price options on a live stream");
    expect(prompt).toContain("Structured Streaming checkpointing");
    expect(prompt).toContain("checkpointLocation is set");
    expect(prompt).toContain("90 minutes");
  });
});

describe("findResources end to end", () => {
  it("returns parsed resources from a grounded reply", async () => {
    const stub: ReasoningModel = {
      id: "stub",
      generate: async () => "",
      search: async () => ({
        text:
          "```json\n" +
          reply([
            {
              url: "https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html",
              title: "The Book, ch. 4",
              kind: "docs",
              minutes: 60,
              cost: 0,
              verdict: "the answer everyone gives on r/rust",
            },
          ]) +
          "\n```",
        citations: [{ url: "https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html" }],
      }),
    };

    const out = await findResources(stub, { node, goalStatement: "Learn Rust" });
    expect(out).toHaveLength(1);
    expect(out[0]?.status).toBe("ok");
    expect(out[0]?.title).toContain("r/rust");
  });

  it("converts a quota refusal into an actionable error, not a raw 429", async () => {
    const stub: ReasoningModel = {
      id: "stub",
      generate: async () => "",
      search: async () => {
        throw new QuotaError("You exceeded your current quota");
      },
    };

    await expect(findResources(stub, { node, goalStatement: "Learn Rust" })).rejects.toThrow(
      /billing-enabled key/,
    );
  });
});

describe("key check", () => {
  it("rejects an empty key without calling the network", async () => {
    await expect(testConnection("   ")).resolves.toEqual({
      ok: false,
      reason: "No key entered.",
    });
  });
});
