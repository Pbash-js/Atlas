/**
 * The reasoning-model boundary.
 *
 * Nothing above this file names a vendor. That is deliberate: `gemini-2.5-pro` already returns
 * 404 "no longer available to new users" for newly created Google Cloud projects, and Google
 * publishes its retirement dates as earliest-possible rather than fixed. A model id is a thing
 * that expires, so it lives behind an interface with the id in one place.
 */

export interface GenerateRequest {
  system: string;
  input: string;
  /** Abort signal so a slow generation can be cancelled from the UI. */
  signal?: AbortSignal;
}

/** A source the live web search actually returned, as opposed to one the model recalled. */
export interface Citation {
  url: string;
  title?: string;
}

export interface GroundedResult {
  text: string;
  citations: Citation[];
}

export interface ReasoningModel {
  readonly id: string;
  generate(req: GenerateRequest): Promise<string>;
  /** Same call, but with live web search attached. See GeminiModel.search. */
  search(req: GenerateRequest): Promise<GroundedResult>;
}

export class MissingKeyError extends Error {
  constructor() {
    super("No Gemini API key. Add VITE_GEMINI_API_KEY to .env, or paste a key in Atlas.");
    this.name = "MissingKeyError";
  }
}

/**
 * Raised when the key is fine but the quota for this particular capability is not.
 * Worth its own type because grounded search is metered separately from plain generation —
 * a key that drafts plans happily can still be refused every web search.
 */
export class QuotaError extends Error {
  constructor(message = "Quota exceeded for this request.") {
    super(message);
    this.name = "QuotaError";
  }
}

const KEY_STORAGE = "atlas.gemini_key";

/** A key pasted at runtime wins over the build-time one, so a shared default can be overridden. */
export function resolveKey(): string | null {
  try {
    const stored = localStorage.getItem(KEY_STORAGE);
    if (stored && stored.trim()) return stored.trim();
  } catch {
    // localStorage can throw in private modes; fall through to the env key.
  }
  const env = import.meta.env?.VITE_GEMINI_API_KEY;
  return env && env.trim() ? env.trim() : null;
}

export function storeKey(key: string) {
  localStorage.setItem(KEY_STORAGE, key.trim());
}

export function hasKey(): boolean {
  return resolveKey() !== null;
}

/**
 * Google's Interactions API — the GA replacement for `generateContent`. Flo talks to the same
 * endpoint, so Atlas reuses its key and its model id rather than inventing a second answer.
 */
export class GeminiModel implements ReasoningModel {
  readonly id = "gemini-3.5-flash";
  private endpoint = "https://generativelanguage.googleapis.com/v1beta/interactions";

  /** An explicit key bypasses browser storage — used by the offline journey harness. */
  constructor(private readonly key?: string) {}

  private async call(
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    key: string,
  ): Promise<GeminiResponse> {
    const res = await fetch(`${this.endpoint}?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.id, stream: false, ...body }),
      signal,
    });

    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      // Never surface the key, which travels in the query string.
      if (res.status === 429) throw new QuotaError(quotaMessage(raw));
      throw new Error(`Gemini ${res.status}: ${raw.slice(0, 400)}`);
    }

    return (await res.json()) as GeminiResponse;
  }

  async generate({ system, input, signal }: GenerateRequest): Promise<string> {
    const key = this.key ?? resolveKey();
    if (!key) throw new MissingKeyError();

    const data = await this.call({ system_instruction: system, input }, signal, key);
    const text = textOf(data);
    if (!text.trim()) throw new Error("Gemini returned no text.");
    return text;
  }

  /**
   * Generation with Google Search attached, so the model answers from the live web rather than
   * from training recall. `google_search` is one of the tool types this endpoint accepts —
   * verified against the API's own rejection message, which enumerates them.
   *
   * Grounded search is metered separately from plain generation. On a free-tier key it is
   * refused outright with 429 while ordinary calls keep succeeding, which is why this surfaces
   * QuotaError rather than a generic failure: the caller needs to tell those two apart.
   */
  async search({ system, input, signal }: GenerateRequest): Promise<GroundedResult> {
    const key = this.key ?? resolveKey();
    if (!key) throw new MissingKeyError();

    const data = await this.call(
      { system_instruction: system, input, tools: [{ type: "google_search" }] },
      signal,
      key,
    );

    return { text: textOf(data), citations: citationsOf(data) };
  }
}

interface GeminiResponse {
  steps?: {
    type?: string;
    content?: { type?: string; text?: string }[];
    [key: string]: unknown;
  }[];
  [key: string]: unknown;
}

function textOf(data: GeminiResponse): string {
  return (data.steps ?? [])
    .filter((s) => s.type === "model_output")
    .flatMap((s) => s.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

/**
 * Pull whatever source URLs the grounded response carries.
 *
 * Deliberately shape-agnostic: it walks the whole response for objects holding a `uri`/`url`,
 * rather than reaching into one documented path. Grounding metadata has moved between
 * `groundingMetadata`, `groundingChunks` and `citationMetadata` across Google's API revisions,
 * and citations here are corroboration rather than the primary channel — the resource list
 * itself comes back as JSON in the model's own reply. Missing them degrades a resource to
 * "unverified"; it never breaks the feature.
 */
function citationsOf(data: unknown): Citation[] {
  const found = new Map<string, Citation>();

  const walk = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || depth > 8) return;

    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }

    const obj = node as Record<string, unknown>;
    const url = obj.uri ?? obj.url;
    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      const title = typeof obj.title === "string" ? obj.title : undefined;
      if (!found.has(url)) found.set(url, { url, title });
    }

    for (const value of Object.values(obj)) walk(value, depth + 1);
  };

  walk(data, 0);
  return [...found.values()];
}

function quotaMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // Non-JSON body; fall through to the generic message.
  }
  return "Quota exceeded for this request.";
}

export type KeyCheck =
  | { ok: true; note?: string }
  | { ok: false; reason: string };

/**
 * Prove a key works before it is committed to storage, so a typo surfaces here rather than
 * forty seconds into drawing a plan.
 *
 * A 429 counts as PASSING: the key authenticated, it is simply rate-limited right now. Refusing
 * to save in that case would lock someone out of a key that is actually theirs and actually valid.
 */
export async function testConnection(key: string, signal?: AbortSignal): Promise<KeyCheck> {
  const candidate = key.trim();
  if (!candidate) return { ok: false, reason: "No key entered." };

  try {
    const probe = new GeminiModel(candidate);
    await probe.generate({ system: "Reply with the single word OK.", input: "OK", signal });
    return { ok: true };
  } catch (err) {
    if (err instanceof QuotaError) {
      return { ok: true, note: "Key accepted, but it is rate-limited right now." };
    }
    if (err instanceof DOMException && err.name === "AbortError") {
      return { ok: false, reason: "Check cancelled." };
    }

    const message = err instanceof Error ? err.message : String(err);
    if (/\b40[13]\b/.test(message) || /API_KEY_INVALID|API key not valid|PERMISSION_DENIED/i.test(message)) {
      return { ok: false, reason: "That key was rejected by Google. Check it and try again." };
    }
    if (/Failed to fetch|NetworkError|ERR_/i.test(message)) {
      return { ok: false, reason: "Could not reach Google. Check your connection." };
    }
    return { ok: false, reason: message.slice(0, 180) };
  }
}

/** Strip the ```json fences models add even when told not to. */
export function extractJson(raw: string): unknown {
  let text = raw.trim();

  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence?.[1]) text = fence[1].trim();

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`No JSON object in the model's reply: ${text.slice(0, 200)}`);
  }

  return JSON.parse(text.slice(start, end + 1));
}
