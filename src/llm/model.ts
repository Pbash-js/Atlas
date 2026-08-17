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

export interface ReasoningModel {
  readonly id: string;
  generate(req: GenerateRequest): Promise<string>;
}

export class MissingKeyError extends Error {
  constructor() {
    super("No Gemini API key. Add VITE_GEMINI_API_KEY to .env, or paste a key in Atlas.");
    this.name = "MissingKeyError";
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

  async generate({ system, input, signal }: GenerateRequest): Promise<string> {
    const key = this.key ?? resolveKey();
    if (!key) throw new MissingKeyError();

    const res = await fetch(`${this.endpoint}?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.id,
        system_instruction: system,
        input,
        stream: false,
      }),
      signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Never surface the key, which travels in the query string.
      throw new Error(`Gemini ${res.status}: ${body.slice(0, 400)}`);
    }

    const data = (await res.json()) as {
      steps?: { type?: string; content?: { type?: string; text?: string }[] }[];
    };

    const text = (data.steps ?? [])
      .filter((s) => s.type === "model_output")
      .flatMap((s) => s.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");

    if (!text.trim()) throw new Error("Gemini returned no text.");
    return text;
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
