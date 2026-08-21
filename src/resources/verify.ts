/**
 * Resource URL handling shared between the automated Librarian (grounded search) and the manual
 * hand-off path (Google AI Mode in a new tab, then the user pastes a link back).
 *
 * Both paths end at the same trust question: is this URL real? They answer it two different,
 * equally honest ways — grounding checks a citation match, the manual path checks that the
 * browser can actually reach the host. Neither is a full HTTP 200 check; CORS makes that
 * impossible from a backend-less client for an arbitrary third-party URL, so this file does not
 * pretend otherwise.
 */

/** Normalise a URL for de-dup and comparison — trailing slashes and tracking params are noise. */
export function urlKey(raw: string): string {
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

export function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Best-effort reachability check for a URL the user pasted in.
 *
 * `mode: "no-cors"` is the only way to touch a third-party origin from the browser without that
 * origin opting in via CORS headers — almost none do for a plain HEAD probe. The response is
 * opaque (status always reads 0), so this can never confirm a 200. What it DOES confirm is that
 * some server answered at all: `fetch` rejects on DNS failure, a refused connection, a blocked
 * mixed-content request, or the timeout below, and resolves for everything else, including a 404
 * or 500 the app has no way to see. That is enough to catch the actual failure mode worth
 * catching here — a typo'd or dead domain — without false-flagging a live site that just doesn't
 * send CORS headers, which is most of them.
 */
export async function isReachable(url: string, timeoutMs = 8000): Promise<boolean> {
  try {
    await fetch(url, { mode: "no-cors", method: "HEAD", signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

/** A short human label derived from the URL itself, for a link with no title of its own. */
export function titleFromUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, "");
    const last = u.pathname.split("/").filter(Boolean).pop();
    if (!last) return host;
    const pretty = decodeURIComponent(last)
      .replace(/[-_]+/g, " ")
      .replace(/\.\w{1,5}$/, "")
      .trim();
    return pretty ? `${host} — ${pretty}` : host;
  } catch {
    return raw;
  }
}
