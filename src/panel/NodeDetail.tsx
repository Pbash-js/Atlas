import { useState } from "react";
import type { AtlasGraph, AtlasNode } from "../schema/atlas";
import type { PlanModel } from "../graph/model";
import { ST, glyphOr } from "../graph/status";
import { C, fmt, numeral, plural } from "../lib/format";
import { buildAiModeUrl } from "../llm/librarian";
import { isHttpUrl } from "../resources/verify";

type Verdict = "passed" | "short" | null;

interface Attempt {
  open: boolean;
  ticks: Record<number, boolean>;
  text: string;
  verdict: Verdict;
}

const EMPTY: Attempt = { open: false, ticks: {}, text: "", verdict: null };

interface Props {
  graph: AtlasGraph;
  model: PlanModel;
  node: AtlasNode | null;
  onSelect: (id: string) => void;
  arabic?: boolean;
  /** Runs the Librarian for this node; resolves once the found resources are saved. */
  onFindResources?: (nodeId: string) => Promise<void>;
  /** Node id currently being searched, so the button can show progress. */
  findingId?: string | null;
  findError?: string | null;
  /** The hand-off path: check a pasted link is reachable, then save it. Resolves true on success. */
  onAddResource?: (nodeId: string, url: string) => Promise<boolean>;
  /** Save the link despite a failed reachability check — the user's own eyes outrank the probe. */
  onAddResourceForced?: (nodeId: string, url: string) => void;
  addingId?: string | null;
  addError?: string | null;
}

export function NodeDetail({
  graph,
  model,
  node,
  onSelect,
  arabic = false,
  onFindResources,
  findingId = null,
  findError = null,
  onAddResource,
  onAddResourceForced,
  addingId = null,
  addError = null,
}: Props) {
  const [attempts, setAttempts] = useState<Record<string, Attempt>>({});
  const [linkDrafts, setLinkDrafts] = useState<Record<string, string>>({});

  if (!node) {
    return (
      <aside className="panel">
        <div className="empty">
          <span className="empty__mark">§</span>
          <p className="empty__h">Nothing is open</p>
          <p className="empty__p">Choose a card and its entry is set out here.</p>
        </div>
      </aside>
    );
  }

  const attempt = attempts[node.id] ?? EMPTY;
  const patch = (p: Partial<Attempt>) =>
    setAttempts((prev) => ({ ...prev, [node.id]: { ...(prev[node.id] ?? EMPTY), ...p } }));

  // The tick must be derived inside the updater. Building it from the render closure loses
  // ticks whenever two boxes are clicked inside one batch.
  const toggleTick = (i: number) =>
    setAttempts((prev) => {
      const cur = prev[node.id] ?? EMPTY;
      if (!cur.open) return prev;
      return { ...prev, [node.id]: { ...cur, ticks: { ...cur.ticks, [i]: !cur.ticks[i] } } };
    });

  const meta = ST[node.status];
  const gated = model.chapters.isGated(node.id);
  const barred = gated || node.status === "locked";
  const chapterIndex = model.chapters.chapterOf.get(node.id) ?? 0;
  const chapter = model.chapters.chapters[chapterIndex];

  const check = node.type === "UNIT" || node.type === "RECOVERY" ? node.exit_check : undefined;
  const resources = node.type === "DECISION" ? [] : node.resources;
  const pitfalls = node.type === "UNIT" ? node.known_pitfalls : [];

  const prereqs = graph.edges
    .filter((e) => e.to === node.id && e.type === "requires")
    .map((e) => ({ n: model.byId.get(e.from), strength: e.strength }))
    .filter((x): x is { n: AtlasNode; strength: number } => Boolean(x.n));

  const unlocks = graph.edges
    .filter((e) => e.from === node.id && e.type === "requires")
    .map((e) => model.byId.get(e.to))
    .filter((n): n is AtlasNode => Boolean(n));

  const chips: { text: string; failed?: boolean }[] = [];
  if (node.type === "UNIT") chips.push({ text: node.kind });
  if (node.type === "RECOVERY") chips.push({ text: "recovery", failed: true });
  if (node.type === "DECISION") chips.push({ text: "decision" });
  if (node.type === "UNIT" || node.type === "RECOVERY") chips.push({ text: fmt(node.estimate_min) });
  if (node.type === "UNIT" && node.attempts > 0) {
    chips.push({ text: plural(node.attempts, "attempt") });
  }

  const rubric = check?.rubric ?? [];
  const ticked = rubric.filter((_, i) => attempt.ticks[i]).length;
  const searching = findingId === node.id;
  const adding = addingId === node.id;
  const linkDraft = linkDrafts[node.id] ?? "";
  const draftLooksLikeAUrl = isHttpUrl(linkDraft.trim());
  // "add anyway" only makes sense once there is a real failed attempt to override, and only for
  // the same URL still sitting in the box — editing it should clear the offer, not carry it over.
  const canForceAdd = Boolean(addError) && !adding && draftLooksLikeAUrl && node.type !== "DECISION";

  const hint = attempt.open
    ? `${ticked} of ${rubric.length} marked`
    : gated
      ? `shut · chapter ${numeral(chapterIndex, arabic)} is not yet open`
      : node.status === "locked"
        ? "locked · prerequisites outstanding"
        : check
          ? `evidence: ${check.evidence}`
          : "";

  return (
    <aside className="panel">
      <header className="panel__head">
        <div className="panel__row">
          <div className="panel__status" style={{ color: C(meta.token) }}>
            {meta.label}
          </div>
          <div className="panel__num tnum">{model.nums.get(node.id) ?? ""}</div>
        </div>
        <div className="panel__chapter">
          {chapter
            ? `Chapter ${numeral(chapter.i, arabic)} · ${chapter.title}${
                chapter.sealed ? " · sealed" : chapter.open ? "" : " · shut"
              }`
            : ""}
        </div>
        <h2 className="panel__title">{node.title}</h2>
        <div className="panel__chips">
          {chips.map((c) => (
            <span key={c.text} className={c.failed ? "chip chip--failed" : "chip"}>
              {c.text}
            </span>
          ))}
        </div>
      </header>

      <section className="sect">
        <h3 className="sect__h">Why you are doing this</h3>
        <p className="sect__p">{node.why}</p>
      </section>

      {node.type === "DECISION" && (
        <section className="sect">
          <h3 className="sect__h">The question</h3>
          <p className="sect__p">{node.question}</p>
        </section>
      )}

      {node.type === "RECOVERY" && (
        <>
          <section className="sect sect--diagnosis">
            <h3 className="sect__h">Diagnosis</h3>
            <p className="sect__p">{node.diagnosis}</p>
          </section>
          <section className="sect">
            <h3 className="sect__h">Remediation</h3>
            <ol className="olist">
              {node.remediation.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          </section>
        </>
      )}

      {prereqs.length > 0 && (
        <section className="sect">
          <h3 className="sect__h">Requires</h3>
          <ul className="ulist">
            {prereqs.map(({ n, strength }) => (
              <li key={n.id} className="linkrow">
                <button className="link" onClick={() => onSelect(n.id)}>
                  <span className="link__glyph" style={{ color: C(ST[n.status].token) }}>
                    {glyphOr(n.status)}
                  </span>
                  <span>{n.title}</span>
                </button>
                {strength < 0.6 && <span className="weak">weak link</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {check && (
        <section className="check">
          <h3 className="sect__h">Exit check</h3>
          <p className="check__lede">You will know you have it when —</p>

          <ul className="check__list">
            {rubric.map((text, i) => (
              <li key={i} className="check__item">
                <button
                  className={[
                    "check__box",
                    attempt.open ? "is-live" : "",
                    attempt.ticks[i] ? "is-ticked" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  title="mark satisfied"
                  onClick={() => toggleTick(i)}
                >
                  {attempt.ticks[i] ? "✓" : ""}
                </button>
                <span style={{ color: attempt.ticks[i] ? C("--at-dim") : C("--at-ink") }}>
                  {text}
                </span>
              </li>
            ))}
          </ul>

          <p className="check__prompt">{check.prompt}</p>

          {attempt.open && (
            <>
              <label className="intake__label">Your account of it</label>
              <textarea
                className="ta"
                rows={6}
                placeholder="Write it out, or paste what you built."
                value={attempt.text}
                onChange={(e) => patch({ text: e.target.value })}
              />
            </>
          )}

          {attempt.verdict && (
            <div
              className="check__verdict"
              style={{
                borderColor: attempt.verdict === "passed" ? C("--at-passed") : C("--at-progress"),
                color: attempt.verdict === "passed" ? C("--at-passed") : C("--at-progress"),
              }}
            >
              <div className="check__verdict-h">
                {attempt.verdict === "passed" ? "Marked · passed" : "Marked · short of it"}
              </div>
              <div className="check__verdict-b">
                {attempt.verdict === "passed"
                  ? "All criteria met. The units downstream open, and if this was the last unit of the chapter its seal is set."
                  : "Some criteria are unmet. Atlas will read your account and, if the gap is local, insert a recovery beside this unit rather than a new prerequisite."}
              </div>
            </div>
          )}

          <div className="check__actions">
            <button
              className="btn"
              disabled={barred}
              onClick={() => {
                if (barred) return;
                if (!attempt.open || attempt.verdict) {
                  patch({ open: true, verdict: null });
                  return;
                }
                patch({
                  verdict: ticked === rubric.length && rubric.length > 0 ? "passed" : "short",
                });
              }}
            >
              {attempt.verdict
                ? "Attempt again"
                : attempt.open
                  ? "Submit for marking"
                  : "Attempt the check"}
            </button>
            {attempt.open && (
              <button
                className="btn btn--quiet"
                onClick={() => patch({ open: false, verdict: null })}
              >
                Set aside
              </button>
            )}
            <span className="check__hint tnum">{hint}</span>
          </div>
        </section>
      )}

      <section className="sect">
        <h3 className="sect__h">Resources</h3>
        {resources.length === 0 ? (
          <p className="none">
            Nothing shelved here yet. Open Google AI Mode for a tailored search, or let Atlas
            search the web itself.
          </p>
        ) : (
          <ul className="ulist">
            {resources.map((r, i) => (
              <li key={i} className="res">
                <a className="res__link" href={r.url} target="_blank" rel="noreferrer">
                  {r.title ?? r.url}
                </a>
                <span className="res__meta tnum">
                  {r.kind} · {fmt(r.minutes)} · {r.cost > 0 ? `₹${r.cost}` : "free"}
                </span>
                {r.status !== "ok" && <span className="res__badge">unverified</span>}
              </li>
            ))}
          </ul>
        )}

        {node.type !== "DECISION" && (
          <div className="res__handoff">
            <a
              className="btn btn--quiet"
              href={buildAiModeUrl({ node, goalStatement: graph.goal.statement })}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open in Google AI Mode ↗
            </a>
            <span className="check__hint">No key needed · opens in a new tab</span>
          </div>
        )}

        {onAddResource && node.type !== "DECISION" && (
          <form
            className="res__addrow"
            onSubmit={(ev) => {
              ev.preventDefault();
              if (!linkDraft.trim() || adding) return;
              void onAddResource(node.id, linkDraft).then((ok) => {
                if (ok) setLinkDrafts((prev) => ({ ...prev, [node.id]: "" }));
              });
            }}
          >
            <input
              type="url"
              className="res__addinput"
              placeholder="Paste a link you found…"
              value={linkDraft}
              disabled={adding}
              onChange={(e) =>
                setLinkDrafts((prev) => ({ ...prev, [node.id]: e.target.value }))
              }
            />
            <button className="btn btn--quiet" type="submit" disabled={adding || !linkDraft.trim()}>
              {adding ? "Checking…" : "Add"}
            </button>
          </form>
        )}

        {addError && !adding && (
          <p className="res__error">
            {addError}
            {canForceAdd && onAddResourceForced && (
              <button
                className="linkbtn-inline"
                onClick={() => {
                  onAddResourceForced(node.id, linkDraft);
                  setLinkDrafts((prev) => ({ ...prev, [node.id]: "" }));
                }}
              >
                Add it anyway
              </button>
            )}
          </p>
        )}

        {onFindResources && node.type !== "DECISION" && (
          <div className="res__find">
            <button
              className="btn btn--quiet"
              disabled={searching}
              onClick={() => void onFindResources(node.id)}
            >
              {searching
                ? "Searching the web…"
                : resources.length
                  ? "Search again"
                  : "Or let Atlas search for you"}
            </button>
            {searching && (
              <span className="check__hint">Reading forums and reviews · up to a minute</span>
            )}
          </div>
        )}

        {findError && !searching && <p className="res__error">{findError}</p>}
      </section>

      {pitfalls.length > 0 && (
        <section className="sect">
          <h3 className="sect__h">What usually goes wrong here</h3>
          <ul className="ulist">
            {pitfalls.map((p, i) => (
              <li key={i} className="pitfall">
                <strong>{p.symptom}</strong>
                <span>{p.cause}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {unlocks.length > 0 && (
        <section className="sect">
          <h3 className="sect__h">Unlocks</h3>
          <ul className="ulist">
            {unlocks.map((u) => (
              <li key={u.id} className="linkrow">
                <button className="link" onClick={() => onSelect(u.id)}>
                  <span className="link__glyph" style={{ color: C(ST[u.status].token) }}>
                    {glyphOr(u.status)}
                  </span>
                  <span>{u.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}
