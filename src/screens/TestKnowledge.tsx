import type { AtlasGraph } from "../schema/atlas";
import { C } from "../lib/format";
import {
  eligibleCards,
  summarise,
  PLAN_QUIZ_CARDS,
  PLAN_QUIZ_PER_CARD,
  type MasteryMap,
} from "../quiz/planquiz";
import { STRONG_AT_OR_ABOVE, WEAK_BELOW } from "../quiz/mastery";

interface Props {
  graph: AtlasGraph;
  masteries: MasteryMap;
  loading: boolean;
  error: string | null;
  onStart: () => void;
  onOpenNode: (nodeId: string) => void;
}

function graspColour(grasp: number | null): string {
  if (grasp === null) return C("--at-faint");
  if (grasp < WEAK_BELOW) return C("--at-failed");
  if (grasp >= STRONG_AT_OR_ABOVE) return C("--at-passed");
  return C("--at-progress");
}

export function TestKnowledge({ graph, masteries, loading, error, onStart, onOpenNode }: Props) {
  const cards = eligibleCards(graph, masteries);
  const summary = summarise(graph, masteries);
  const ready = cards.length > 0;

  return (
    <div className="scroll">
      <div className="testroom">
        <div className="kicker">Test your knowledge</div>
        <h2 className="testroom__h">The whole plan</h2>
        <p className="testroom__lede">
          A mixed test drawn from across the cards you have worked, weighted towards whatever has
          gone shakiest — and it keeps something solid in the mix to confirm it has held.
        </p>

        {!ready ? (
          <div className="testroom__empty">
            <p className="none">
              Nothing to test yet. Pass a card, or take a quiz on one, and it becomes eligible
              here. Locked cards are deliberately left out — testing you on work you have not
              reached would prove nothing.
            </p>
          </div>
        ) : (
          <>
            <div className="testroom__summary">
              <div className="testroom__figure">
                <div
                  className="testroom__grasp tnum"
                  style={{ color: graspColour(summary.overall) }}
                >
                  {summary.overall === null ? "—" : `${Math.round(summary.overall * 100)}%`}
                </div>
                <div className="testroom__figure-label">grasp across tested cards</div>
              </div>
              <div className="testroom__figure">
                <div className="testroom__grasp tnum">
                  {summary.tested}
                  <span className="testroom__of">/{summary.eligible}</span>
                </div>
                <div className="testroom__figure-label">cards quizzed · of those eligible</div>
              </div>
              <div className="testroom__figure">
                <div className="testroom__grasp tnum">{summary.totalUnits}</div>
                <div className="testroom__figure-label">units in the plan</div>
              </div>
            </div>

            <div className="testroom__actions">
              <button className="btn" disabled={loading} onClick={onStart}>
                {loading ? "Writing the test…" : "Start the test"}
              </button>
              <span className="check__hint tnum">
                up to {PLAN_QUIZ_CARDS} cards · {PLAN_QUIZ_PER_CARD} questions each
              </span>
            </div>

            {error && <p className="res__error">{error}</p>}

            <h3 className="testroom__sub">What is in the pool</h3>
            <ul className="testroom__cards">
              {[...cards]
                .sort((a, b) => b.weight - a.weight)
                .map((c) => (
                  <li key={c.nodeId} className="testcard">
                    <button className="testcard__title" onClick={() => onOpenNode(c.nodeId)}>
                      {c.title}
                    </button>
                    <div className="testcard__bar">
                      <div
                        className="testcard__fill"
                        style={{
                          width: `${Math.round((c.grasp ?? 0) * 100)}%`,
                          background: graspColour(c.grasp),
                        }}
                      />
                    </div>
                    <span className="testcard__grasp tnum" style={{ color: graspColour(c.grasp) }}>
                      {c.grasp === null ? "untested" : `${Math.round(c.grasp * 100)}%`}
                    </span>
                  </li>
                ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
