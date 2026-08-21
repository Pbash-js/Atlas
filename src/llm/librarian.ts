import { z } from "zod";
import type { Resource, UnitNode, RecoveryNode } from "../schema/atlas";
import { extractJson, QuotaError, type ReasoningModel } from "./model";
import { urlKey } from "../resources/verify";

/**
 * Two ways to find resources for one node, and they end at the same shape.
 *
 * The automatic path (`findResources`) asks Gemini to search the web itself. That needs a
 * billing-enabled key — grounded search is metered separately from plan drafting, and Google
 * refuses it outright on a free-tier key. `buildAiModeUrl` is the fallback that needs no key at
 * all: it hands the same question to Google's own AI Mode in a new tab and lets the person doing
 * the research complete the loop by pasting a link back (see resources/verify.ts for how that
 * link then gets checked). Neither path is decoration for the other — the second one is what
 * makes resource discovery work for every visitor, not just ones with a paid key.
 *
 * The whole point of routing either path through live search rather than model recall is that a
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
 * A deep link into Google's AI Mode (`udm=50` — the parameter Google's own search UI uses to open
 * that tab; confirmed against Google's current URL scheme, not guessed) with a conversational
 * question built the same way `buildPrompt` frames one for Gemini: what the node needs, why, and
 * a nudge toward community sources over SEO listicles. AI Mode is built for natural-language
 * questions rather than keywords, so the query reads as a sentence, not a keyword string.
 *
 * This never touches the network itself — it only builds the URL. The tab it opens is Google's
 * own page, running the search under the visitor's own Google session, at no cost to this app
 * and with no key required at all. That is what makes it the fallback that works for everyone.
 */
export function buildAiModeUrl({ node, goalStatement }: LibrarianInput): string {
  const query = [
    `What are the best, most up-to-date, well-reviewed resources for "${node.title}"`,
    `as part of learning to: ${goalStatement}?`,
    `Prefer recent, positively-reviewed recommendations from Reddit, Hacker News, Medium, or the`,
    `relevant community — not SEO listicles.`,
  ].join(" ");

  const url = new URL("https://www.google.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("udm", "50");
  return url.toString();
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
