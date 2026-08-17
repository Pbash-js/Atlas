import type { Phase } from "../llm/architect";

interface Props {
  goal: string;
  phase: Phase | null;
  error: string | null;
  onRetry: () => void;
  onBack: () => void;
}

/**
 * The generation screen. Each line corresponds to a request that actually happened — "repairing"
 * only appears when the validator genuinely rejected a draft and it went back to the model. A
 * progress theatre that advanced on a timer would be lying about how long this takes and about
 * what went wrong when it fails.
 */
const STEPS = [
  { key: "read", label: "Reading the goal" },
  { key: "drafting", label: "Decomposing backwards from the capability" },
  { key: "checking", label: "Verifying edges and exit checks" },
  { key: "done", label: "The plan is drawn" },
] as const;

function stateOf(step: string, phase: Phase | null): "done" | "active" | "pending" {
  if (!phase) return step === "read" ? "active" : "pending";
  const order = ["read", "drafting", "checking", "done"];
  const current = phase.step === "repairing" ? "drafting" : phase.step;
  const i = order.indexOf(step);
  const j = order.indexOf(current);
  if (phase.step === "done") return "done";
  if (i < j) return "done";
  if (i === j) return "active";
  return "pending";
}

export function Generating({ goal, phase, error, onRetry, onBack }: Props) {
  const repairing = phase?.step === "repairing" ? phase : null;

  return (
    <div className="scroll">
      <div className="gen">
        <div className="kicker">{error ? "It did not draw" : "Drawing the plan"}</div>
        <h2 className="gen__h">{goal}</h2>

        {error ? (
          <>
            <p className="gen__err">{error}</p>
            <div className="intake__foot" style={{ borderTop: "none", paddingTop: 4 }}>
              <button className="btn" onClick={onRetry}>
                Try again
              </button>
              <button className="btn btn--quiet" onClick={onBack}>
                Back to the form
              </button>
            </div>
          </>
        ) : (
          <>
            <ol className="gen__steps">
              {STEPS.map((s) => {
                const state = stateOf(s.key, phase);
                return (
                  <li key={s.key} className={`gen__step is-${state}`}>
                    <span className="gen__mark">
                      {state === "done" ? "◈" : state === "active" ? "◐" : "○"}
                    </span>
                    <span>{s.label}</span>
                  </li>
                );
              })}
            </ol>

            {repairing && (
              <div className="gen__repair">
                <div className="gen__repair-h">
                  Rejected — asking again (attempt {repairing.attempt} of 3)
                </div>
                <ul>
                  {repairing.problems.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </div>
            )}

            <p className="gen__note">
              Atlas is drafting, then checking its own draft against the rules that make a graph a
              graph. A rejected draft goes back for repair, so this can take a minute.
            </p>
            <button className="btn btn--quiet" onClick={onBack}>
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}
