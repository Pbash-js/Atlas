import { useMemo, useState } from "react";
import type { StoredPlan } from "../store/plans";
import { relativeDay } from "../store/plans";
import { buildPlanModel } from "../graph/model";
import { C, numeral } from "../lib/format";

const FILTERS = ["All", "In hand", "Sealed"] as const;
type Filter = (typeof FILTERS)[number];

interface Props {
  plans: StoredPlan[];
  onOpen: (planId: string) => void;
  onNew: () => void;
  arabic?: boolean;
}

export function Home({ plans, onOpen, onNew, arabic = false }: Props) {
  const [filter, setFilter] = useState<Filter>("All");

  // Every number on a card comes from the plan's own graph. Nothing here is stored or guessed.
  const cards = useMemo(
    () =>
      plans.map((p) => {
        const model = buildPlanModel(p.graph);
        const sealed = model.units.length > 0 && model.passed === model.units.length;
        return {
          id: p.id,
          title: p.graph.goal.statement,
          blurb: p.graph.goal.terminal_capability,
          units: model.units.length,
          passed: model.passed,
          pct: model.pct,
          chapters: model.chapters.chapters.map((c) => c.sealed),
          state: sealed ? "sealed" : "in hand",
          touched: relativeDay(p.touched),
        };
      }),
    [plans],
  );

  const shown = cards.filter((c) =>
    filter === "All" ? true : filter === "Sealed" ? c.state === "sealed" : c.state === "in hand",
  );

  return (
    <div className="scroll">
      <div className="room">
        <div className="room__head">
          <div>
            <div className="kicker">The reading room</div>
            <h2 className="room__h">Your plans</h2>
          </div>
          <div className="room__filters">
            {FILTERS.map((f) => (
              <button
                key={f}
                className={f === filter ? "seg__btn is-active" : "seg__btn"}
                onClick={() => setFilter(f)}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        <div className="grid">
          <button className="plan plan--new" onClick={onNew}>
            <span
              style={{
                fontFamily: "var(--font-heading)",
                fontSize: 30,
                color: C("--at-gold"),
                lineHeight: 1,
              }}
            >
              ＋
            </span>
            <span style={{ fontFamily: "var(--font-heading)", fontSize: 21 }}>Open a new plan</span>
            <span className="none">
              Name the capability; Atlas draws the graph and keeps rewriting it.
            </span>
          </button>

          {shown.map((p, i) => (
            <div key={p.id} className="plan" onClick={() => onOpen(p.id)}>
              <div className="plan__row">
                <span className="plan__num tnum">{numeral(i, arabic)}</span>
                <span
                  className="plan__state"
                  style={{ color: p.state === "sealed" ? C("--at-passed") : C("--at-gold") }}
                >
                  {p.state}
                </span>
              </div>

              <h3 className="plan__title">{p.title}</h3>
              <p className="plan__blurb">{p.blurb}</p>

              <div className="plan__foot">
                <div className="plan__meta tnum">
                  <span>
                    {p.passed} of {p.units} units
                  </span>
                  <span>{p.touched}</span>
                </div>
                <div className="plan__bar">
                  <div
                    style={{
                      position: "absolute",
                      inset: "0 auto 0 0",
                      width: `${p.pct}%`,
                      background: p.state === "sealed" ? C("--at-passed") : C("--at-gold"),
                    }}
                  />
                </div>
                <div className="plan__chapters">
                  {p.chapters.map((done, ci) => (
                    <span
                      key={ci}
                      className="plan__chapter"
                      style={{ background: done ? C("--at-gold") : C("--at-rule") }}
                    />
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>

        {shown.length === 0 && (
          <p className="none" style={{ marginTop: 26 }}>
            {plans.length === 0
              ? "No plans yet. Open one and Atlas will draw the graph."
              : `Nothing is ${filter.toLowerCase()}.`}
          </p>
        )}
      </div>
    </div>
  );
}
