import { useState } from "react";
import type { ArchitectInput } from "../llm/architect";
import { hasKey, storeKey } from "../llm/model";

const BUDGETS = ["3 hrs", "6 hrs", "10 hrs", "15+ hrs"];

interface Props {
  initial?: ArchitectInput | null;
  onDraw: (input: ArchitectInput) => void;
}

export function Intake({ initial, onDraw }: Props) {
  const [goal, setGoal] = useState(initial?.goal ?? "");
  const [known, setKnown] = useState(initial?.known ?? "");
  const [budget, setBudget] = useState(initial?.weeklyHours ?? "6 hrs");
  const [keyed, setKeyed] = useState(hasKey());
  const [keyDraft, setKeyDraft] = useState("");

  const ready = goal.trim().length >= 8 && keyed;

  return (
    <div className="scroll">
      <div className="intake">
        <div className="kicker">New plan</div>
        <h2 className="intake__h">What do you mean to learn?</h2>
        <p className="intake__lede">
          Three answers are enough. Atlas draws the graph, then rewrites it as you pass and fail.
        </p>

        {!keyed && (
          <div className="intake__field" style={{ borderTop: "none", paddingTop: 0 }}>
            <label className="intake__label" htmlFor="key">
              A Gemini API key — held in this browser only, never sent anywhere but Google
            </label>
            <div className="keyrow">
              <input
                id="key"
                type="password"
                placeholder="AIza…"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
              />
              <button
                className="btn"
                disabled={keyDraft.trim().length < 20}
                onClick={() => {
                  storeKey(keyDraft);
                  setKeyDraft("");
                  setKeyed(hasKey());
                }}
              >
                Keep it
              </button>
            </div>
          </div>
        )}

        <div className="intake__field">
          <label className="intake__label" htmlFor="goal">
            The capability, stated as something you could do
          </label>
          <textarea
            id="goal"
            className="ta"
            rows={3}
            placeholder="Stream a Tradier option chain and price every contract with Black-Scholes"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
          />
        </div>

        <div className="intake__field">
          <label className="intake__label">Hours you can give it each week</label>
          <div className="seg" style={{ width: "fit-content" }}>
            {BUDGETS.map((b) => (
              <button
                key={b}
                className={b === budget ? "seg__btn is-active" : "seg__btn"}
                onClick={() => setBudget(b)}
              >
                {b}
              </button>
            ))}
          </div>
        </div>

        <div className="intake__field">
          <label className="intake__label" htmlFor="known">
            What you already hold — one per line, so it is not planned twice
          </label>
          <textarea
            id="known"
            className="ta"
            rows={4}
            placeholder={"Spark DataFrames\nPython, comfortably\nundergraduate calculus"}
            value={known}
            onChange={(e) => setKnown(e.target.value)}
          />
        </div>

        <div className="intake__foot">
          <button
            className="btn"
            disabled={!ready}
            onClick={() => onDraw({ goal: goal.trim(), weeklyHours: budget, known })}
          >
            Draw the plan
          </button>
          <span className="intake__note">
            {!keyed
              ? "A key is needed before Atlas can draw anything."
              : goal.trim().length < 8
                ? "Name the capability first."
                : `Atlas plans against ${budget} a week.`}
          </span>
        </div>
      </div>
    </div>
  );
}
