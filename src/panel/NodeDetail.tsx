import { useState } from "react";
import type { AtlasGraph, AtlasNode } from "../schema/atlas";
import type { PlanModel } from "../graph/model";
import { ST, glyphOr } from "../graph/status";
import { C, fmt, numeral, plural } from "../lib/format";
import { buildAiModeUrl } from "../llm/librarian";
import { isHttpUrl } from "../resources/verify";
import type { Question, Result } from "../quiz/types";
import {
  overallStrength,
  strongConcepts,
  weakConcepts,
  type NodeMastery,
} from "../quiz/mastery";

/** The live quiz for the open card: its questions, and its marks once submitted. */
export interface QuizState {
  nodeId: string;
  questions: Question[];
  results: Result[] | null;
  marking: boolean;
  /** Answers restored from the cache when a set-aside quiz is reopened. */
  answers?: Record<string, string>;
  /** True when these questions came from the cache rather than a fresh generation. */
  fromCache?: boolean;
}

function MasterySummary({ mastery }: { mastery: NodeMastery }) {
  const overall = overallStrength(mastery);
  const weak = weakConcepts(mastery).slice(0, 3);
  const strong = strongConcepts(mastery).slice(0, 3);

  return (
    <div className="mastery">
      <div className="mastery__bar">
        <div
          className="mastery__fill"
          style={{ width: `${Math.round((overall ?? 0) * 100)}%` }}
        />
      </div>
      <div className="mastery__meta tnum">
        <span>{Math.round((overall ?? 0) * 100)}% grasp</span>
        <span>
          {mastery.quizzes} quiz{mastery.quizzes === 1 ? "" : "zes"} · {mastery.concepts.length}{" "}
          concepts
        </span>
      </div>

      {weak.length > 0 && (
        <div className="mastery__group">
          <span className="mastery__label" style={{ color: C("--at-failed") }}>
            Shaky
          </span>
          {weak.map((c) => (
            <span key={c.concept} className="mastery__chip is-weak">
              {c.concept}
            </span>
          ))}
        </div>
      )}

      {strong.length > 0 && (
        <div className="mastery__group">
          <span className="mastery__label" style={{ color: C("--at-passed") }}>
            Solid
          </span>
          {strong.map((c) => (
            <span key={c.concept} className="mastery__chip is-strong">
              {c.concept}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

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
  /** Quiz wiring. The panel renders; the host owns generation, marking and persistence. */
  onTakeQuiz?: (nodeId: string, opts?: { fresh?: boolean }) => void;
  /** True while the quiz modal is showing this card's quiz. */
  quizOpen?: boolean;
  /** A cached, un-submitted quiz is waiting for this card. */
  quizResumable?: boolean;
  quizLoading?: boolean;
  quizError?: string | null;
  mastery?: NodeMastery | null;
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
  onTakeQuiz,
  quizOpen = false,
  quizResumable = false,
  quizLoading = false,
  quizError = null,
  mastery = null,
}: Props) {
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
  const searching = findingId === node.id;
  const adding = addingId === node.id;
  const linkDraft = linkDrafts[node.id] ?? "";
  const draftLooksLikeAUrl = isHttpUrl(linkDraft.trim());
  // "add anyway" only makes sense once there is a real failed attempt to override, and only for
  // the same URL still sitting in the box — editing it should clear the offer, not carry it over.
  const canForceAdd = Boolean(addError) && !adding && draftLooksLikeAUrl && node.type !== "DECISION";
  const resumable = quizResumable && !quizOpen;

  const hint = gated
    ? `shut · chapter ${numeral(chapterIndex, arabic)} is not yet open`
    : node.status === "locked"
      ? "locked · prerequisites outstanding"
      : mastery && mastery.quizzes > 0
        ? `${mastery.quizzes} taken`
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
          <h3 className="sect__h">Test your knowledge</h3>

          {
            <>
              <p className="check__lede">
                {quizOpen
                  ? "The quiz is open."
                  : mastery && mastery.quizzes > 0
                    ? "Atlas remembers where you slipped. The next quiz leans on those."
                    : "A short quiz, written for this card. Atlas marks it and remembers what to drill."}
              </p>

              {mastery && mastery.concepts.length > 0 && (
                <MasterySummary mastery={mastery} />
              )}

              <div className="check__actions">
                <button
                  className="btn"
                  disabled={barred || quizLoading || quizOpen}
                  onClick={() => onTakeQuiz?.(node.id)}
                >
                  {quizLoading
                    ? "Writing the quiz…"
                    : quizOpen
                      ? "Quiz open"
                      : resumable
                        ? "Resume quiz"
                        : mastery && mastery.quizzes > 0
                          ? "Take another quiz"
                          : "Take a quiz"}
                </button>
                {resumable && !quizOpen && (
                  <button
                    className="btn btn--quiet"
                    disabled={barred || quizLoading}
                    onClick={() => onTakeQuiz?.(node.id, { fresh: true })}
                  >
                    Fresh questions
                  </button>
                )}
                <span className="check__hint tnum">{resumable ? "saved · picks up where you left off" : hint}</span>
              </div>

              {quizError && <p className="res__error">{quizError}</p>}

              <details className="check__spec">
                <summary>What this card is checking</summary>
                <ul className="check__speclist">
                  {rubric.map((text, i) => (
                    <li key={i}>{text}</li>
                  ))}
                </ul>
                <p className="check__prompt">{check.prompt}</p>
              </details>
            </>
          }
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
