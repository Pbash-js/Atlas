import { z } from "zod";
import type { Resource, UnitNode, RecoveryNode } from "../schema/atlas";
import { extractJson, QuotaError, type ReasoningModel } from "./model";

/**
 * The Librarian: find real, well-regarded resources for one node.
 *
 * The whole point of routing this through live web search rather than model recall is that a
 * plausible-looking dead URL destroys trust in the entire graph on the very first card. A model
 * asked from memory will happily invent a course that never existed; a grounded search returns
 * things that are actually indexed today.
 *
 * The prompt is aimed at where practitioners actually say what worked — Reddit, Hacker News,
 * Medium, Stack Overflow, and whatever the domain's own community is — rather than at SEO
 * listicles, which is the default thing a naive "best resources for X" search returns.
 */

const DraftResource = z.object({
  url: z.string().url(),
  title: z.string().min(2),
  kind: z.enum(["video", "text", "paper", "course", "docs", "exercise"]),
  minutes: z.number().int().positive().max(6000),
  cost: z.number().nonnegative().default(0),
  /** One line on what the community actually said about it. Shown as the recommendation. */
  verdict: z.string().min(4).optional(),
});

const Draft = z.object({
  resources: z.array(DraftResource).default([]),
});

const SYSTEM = `You find learning resources that real practitioners recommend, using web search.

You MUST search the web before answering. Do not answer from memory.

WHERE TO LOOK — prefer places where people report what actually worked for them:
- Reddit threads (r/learnprogramming, r/rust, r/dataengineering, and whatever subreddit fits the topic)
- Hacker News discussions
- Medium, dev.to, Substack write-ups by practitioners
- Stack Overflow answers that recommend a canonical source
- The domain's own community: LeetCode/HackerEarth for algorithms, arXiv or course pages for theory, YouTube channels people repeatedly name, official documentation when it is genuinely the best text

WHAT TO PREFER:
- RECENT. Prefer things published or substantially updated in the last 2-3 years. Say so if a resource is older but still the standard reference.
- POSITIVELY REVIEWED. Prefer resources multiple people independently recommend. Ignore anything whose only endorsement is its own marketing.
- SPECIFIC. Link the actual chapter, video, or article — not a site's home page.
- FREE FIRST. Prefer free resources; include a paid one only when it is clearly better, and set its cost.

WHAT TO REJECT:
- SEO listicles ("Top 10 best courses for..."), content farms, and affiliate roundups.
- Any URL you are not confident currently resolves. Returning fewer good resources beats padding the list.

Return 2 to 4 resources. Reply with a single JSON object and nothing else — no prose, no code fences:

{
  "resources": [
    { "url": "https://...", "title": "...", "kind": "video|text|paper|course|docs|exercise",
      "minutes": 45, "cost": 0, "verdict": "what people say about it, in one line" }
  ]
}

"minutes" is your honest estimate of time to work through it. "cost" is in rupees, 0 for free.`;

export interface LibrarianInput {
  node: UnitNode | RecoveryNode;
  goalStatement: string;
}

/** Normalise a URL for comparison — trailing slashes and tracking params are not differences. */
function urlKey(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    for (const p of [...u.searchParams.keys()]) {
      if (/^utm_|^ref$|^source$/i.test(p)) u.searchParams.delete(p);
    }
    return `${u.host.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}${u.search}`.toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

export function buildPrompt({ node, goalStatement }: LibrarianInput): string {
  const rubric = node.exit_check?.rubric ?? [];
  return [
    `OVERALL GOAL: ${goalStatement}`,
    `THIS STEP: ${node.title}`,
    `WHY IT MATTERS HERE: ${node.why}`,
    rubric.length
      ? `THE LEARNER MUST BE ABLE TO:\n${rubric.map((r) => `- ${r}`).join("\n")}`
      : "",
    `Budget roughly ${node.estimate_min} minutes total.`,
    `Search the web for what practitioners currently recommend for exactly this, and return the JSON.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Turn a grounded reply into resources.
 *
 * A resource is marked `ok` only when its URL also appears in the search citations — that is the
 * difference between "the live index returned this" and "the model asserted it". Anything the
 * model named without a matching citation still ships, but honestly labelled `unverified`, which
 * is what the panel renders a warning badge for.
 */
export function toResources(
  raw: string,
  citations: { url: string }[],
  today = new Date().toISOString().slice(0, 10),
): Resource[] {
  const draft = Draft.parse(extractJson(raw));
  const cited = new Set(citations.map((c) => urlKey(c.url)));
  const seen = new Set<string>();
  const out: Resource[] = [];

  for (const r of draft.resources) {
    const key = urlKey(r.url);
    if (seen.has(key)) continue;
    seen.add(key);

    const grounded = cited.has(key);
    out.push({
      url: r.url,
      title: r.verdict ? `${r.title} — ${r.verdict}` : r.title,
      kind: r.kind,
      minutes: r.minutes,
      cost: r.cost,
      verified: grounded ? today : null,
      status: grounded ? "ok" : "unverified",
    });
  }

  return out;
}

export class GroundingUnavailableError extends Error {
  constructor() {
    super(
      "Google refused the web search for this key. Grounded search is metered separately from " +
        "plan drafting, and the free tier does not include it — a billing-enabled key is needed.",
    );
    this.name = "GroundingUnavailableError";
  }
}

export async function findResources(
  model: ReasoningModel,
  input: LibrarianInput,
  signal?: AbortSignal,
): Promise<Resource[]> {
  try {
    const { text, citations } = await model.search({
      system: SYSTEM,
      input: buildPrompt(input),
      signal,
    });
    return toResources(text, citations);
  } catch (err) {
    if (err instanceof QuotaError) throw new GroundingUnavailableError();
    throw err;
  }
}
