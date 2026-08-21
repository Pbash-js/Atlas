import { describe, it, expect, vi, afterEach } from "vitest";
import { urlKey, isHttpUrl, isReachable, titleFromUrl } from "../src/resources/verify";

describe("isHttpUrl", () => {
  it.each([
    ["https://example.com/a", true],
    ["http://example.com", true],
    ["ftp://example.com/file", false],
    ["javascript:alert(1)", false],
    ["not a url", false],
    ["", false],
])("%s -> %s", (input, expected) => {
    expect(isHttpUrl(input)).toBe(expected);
  });
});

describe("urlKey", () => {
  it("treats www and a trailing slash as the same resource", () => {
    expect(urlKey("https://www.example.com/guide/")).toBe(urlKey("https://example.com/guide"));
  });

  it("strips tracking params but keeps meaningful query params", () => {
    expect(urlKey("https://example.com/a?utm_source=reddit&id=5")).toBe(
      urlKey("https://example.com/a?id=5"),
    );
  });

  it("is case-insensitive on the host", () => {
    expect(urlKey("https://Example.com/a")).toBe(urlKey("https://example.com/a"));
  });

  it("falls back to a trimmed lowercase string for unparseable input", () => {
    expect(urlKey("  Not A Url  ")).toBe("not a url");
  });
});

describe("titleFromUrl", () => {
  it("prefers the last path segment, prettified", () => {
    expect(titleFromUrl("https://doc.rust-lang.org/book/ch04-01-ownership.html")).toBe(
      "doc.rust-lang.org — ch04 01 ownership",
    );
  });

  it("falls back to the bare host when there is no path", () => {
    expect(titleFromUrl("https://example.com/")).toBe("example.com");
  });

  it("drops a leading www", () => {
    expect(titleFromUrl("https://www.example.com/")).toBe("example.com");
  });
});

describe("isReachable", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("returns true when the request resolves at all, regardless of status", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({} as Response);
    expect(await isReachable("https://example.com")).toBe(true);
  });

  it("returns false when the network call throws", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await isReachable("https://dead.invalid")).toBe(false);
  });

  it("probes with a no-cors HEAD request, never trusting a readable status", async () => {
    const spy = vi.fn().mockResolvedValue({} as Response);
    globalThis.fetch = spy;
    await isReachable("https://example.com");
    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(init.mode).toBe("no-cors");
    expect(init.method).toBe("HEAD");
  });
});
