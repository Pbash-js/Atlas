import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./theme.css";

import { buildPlanModel } from "./graph/model";
import { Canvas } from "./graph/Canvas";
import { NodeDetail } from "./panel/NodeDetail";
import { Home } from "./screens/Home";
import { Chronicle } from "./screens/Chronicle";
import { Intake } from "./screens/Intake";
import { Generating } from "./screens/Generating";
import {
  listPlans,
  savePlan,
  seedOnce,
  setNodeResources,
  touchPlan,
  type StoredPlan,
} from "./store/plans";
import { architect, type ArchitectInput, type Phase } from "./llm/architect";
import { findResources } from "./llm/librarian";
import { GeminiModel } from "./llm/model";
import { fmt } from "./lib/format";

type Screen = "home" | "plan" | "chronicle" | "intake" | "generating";
type Ground = "dark" | "soft";

const VIEWS: { key: Screen; label: string }[] = [
  { key: "home", label: "Room" },
  { key: "plan", label: "Plan" },
  { key: "chronicle", label: "Chronicle" },
  { key: "intake", label: "New" },
];

const ARABIC = false;
const SHOW_LEGEND = true;

const model = new GeminiModel();

/** Opening a plan lands on something you can actually start, not an empty panel. */
function openingNode(plan: StoredPlan | null): string | null {
  if (!plan) return null;
  const nodes = plan.graph.nodes;
  const pick =
    nodes.find((n) => n.status === "in_progress") ??
    nodes.find((n) => n.status === "failed") ??
    nodes.find((n) => n.status === "ready") ??
    nodes[0];
  return pick?.id ?? null;
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [plans, setPlans] = useState<StoredPlan[]>([]);
  const [screen, setScreen] = useState<Screen>("home");
  const [planId, setPlanId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ground, setGround] = useState<Ground>("dark");

  const [findingId, setFindingId] = useState<string | null>(null);
  const [findError, setFindError] = useState<string | null>(null);

  const [phase, setPhase] = useState<Phase | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [lastInput, setLastInput] = useState<ArchitectInput | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    document.body.setAttribute("data-ground", ground);
  }, [ground]);

  // Storage is synchronous but seeding is a real first-run step, so the shell waits for it
  // rather than flashing an empty reading room.
  useEffect(() => {
    seedOnce();
    const loaded = listPlans();
    setPlans(loaded);
    setPlanId(loaded[0]?.id ?? null);
    setSelectedId(openingNode(loaded[0] ?? null));
    setReady(true);
  }, []);

  const current = useMemo(
    () => plans.find((p) => p.id === planId) ?? plans[0] ?? null,
    [plans, planId],
  );

  const planModel = useMemo(
    () => (current ? buildPlanModel(current.graph, ARABIC) : null),
    [current],
  );

  const draw = useCallback(async (input: ArchitectInput) => {
    setLastInput(input);
    setGenError(null);
    setPhase(null);
    setScreen("generating");

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await architect(model, input, setPhase, controller.signal);
      const saved = savePlan(result.graph);
      setPlans(listPlans());
      setPlanId(saved.id);
      setSelectedId(openingNode(saved));
      setScreen("plan");
    } catch (err) {
      if (controller.signal.aborted) return;
      setGenError(err instanceof Error ? err.message : String(err));
    } finally {
      abortRef.current = null;
    }
  }, []);

  /**
   * Run the Librarian for one node and persist what it finds. Failures are reported in place
   * rather than thrown away — the commonest one (no grounded-search quota on the key) is
   * something the user can act on, so it must reach them intact.
   */
  const handleFindResources = useCallback(
    async (nodeId: string) => {
      const plan = current;
      const target = plan?.graph.nodes.find((n) => n.id === nodeId);
      if (!plan || !target || target.type === "DECISION") return;

      setFindError(null);
      setFindingId(nodeId);
      try {
        const found = await findResources(model, {
          node: target,
          goalStatement: plan.graph.goal.statement,
        });
        if (found.length === 0) {
          setFindError("The search came back with nothing usable. Try again in a moment.");
          return;
        }
        setNodeResources(plan.graph, nodeId, found);
        setPlans(listPlans());
      } catch (err) {
        setFindError(err instanceof Error ? err.message : String(err));
      } finally {
        setFindingId(null);
      }
    },
    [current],
  );

  const cancelDraw = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase(null);
    setGenError(null);
    setScreen("intake");
  }, []);

  const openNode = (id: string) => {
    setSelectedId(id);
    setScreen("plan");
  };

  if (!ready) {
    return (
      <div className="app">
        <div className="scroll">
          <div className="gen">
            <div className="kicker">Atlas</div>
            <h2 className="gen__h">Opening the reading room…</h2>
          </div>
        </div>
      </div>
    );
  }

  const sealed = planModel?.chapters.chapters.filter((c) => c.sealed).length ?? 0;
  const selected = current?.graph.nodes.find((n) => n.id === selectedId) ?? null;
  const showRecord = screen === "plan" && planModel !== null;

  return (
    <div className="app">
      <header className="hdr">
        <div className="hdr__left">
          <button className="hdr__brand" onClick={() => setScreen("home")}>
            Atlas
          </button>
          <span className="hdr__div" />
          <h1 className="hdr__title">
            {screen === "home"
              ? "The reading room"
              : screen === "intake"
                ? "A new plan"
                : screen === "generating"
                  ? "Drawing the plan"
                  : (current?.graph.goal.statement ?? "No plan open")}
          </h1>
        </div>

        <div className="hdr__right">
          {showRecord && planModel && (
            <div className="record">
              <span className="record__label tnum">
                {sealed}/{planModel.chapters.chapters.length} sealed ·{" "}
                {fmt(planModel.bankedMinutes)} banked
              </span>
              <span className="record__pct tnum">
                {planModel.passed} of {planModel.units.length} units · {planModel.pct}%
              </span>
              <div className="meter">
                <div className="meter__fill" style={{ width: `${planModel.pct}%` }} />
              </div>
            </div>
          )}

          <div className="seg">
            {VIEWS.map((v) => (
              <button
                key={v.key}
                className={screen === v.key ? "seg__btn is-active" : "seg__btn"}
                disabled={(v.key === "plan" || v.key === "chronicle") && !current}
                onClick={() => setScreen(v.key)}
              >
                {v.label}
              </button>
            ))}
          </div>

          <button
            className="ground-btn"
            title={ground === "dark" ? "to the paper ground" : "to the candlelit ground"}
            onClick={() => setGround(ground === "dark" ? "soft" : "dark")}
          >
            {ground === "dark" ? "◑" : "◐"}
          </button>
        </div>
      </header>

      <main className="main">
        {screen === "home" && (
          <Home
            plans={plans}
            arabic={ARABIC}
            onOpen={(id) => {
              touchPlan(id);
              setPlanId(id);
              setSelectedId(openingNode(plans.find((p) => p.id === id) ?? null));
              setScreen("plan");
            }}
            onNew={() => setScreen("intake")}
          />
        )}

        {screen === "plan" &&
          (current && planModel ? (
            <>
              <Canvas
                graph={current.graph}
                model={planModel}
                selectedId={selectedId}
                onSelect={setSelectedId}
                arabic={ARABIC}
                showLegend={SHOW_LEGEND}
              />
              <NodeDetail
                graph={current.graph}
                model={planModel}
                node={selected}
                onSelect={setSelectedId}
                arabic={ARABIC}
                onFindResources={handleFindResources}
                findingId={findingId}
                findError={findError}
              />
            </>
          ) : (
            <div className="scroll">
              <div className="gen">
                <div className="kicker">Nothing open</div>
                <h2 className="gen__h">There is no plan to show yet.</h2>
                <button className="btn" onClick={() => setScreen("intake")}>
                  Open a new plan
                </button>
              </div>
            </div>
          ))}

        {screen === "chronicle" &&
          (current && planModel ? (
            <Chronicle graph={current.graph} model={planModel} onOpenNode={openNode} />
          ) : (
            <div className="scroll">
              <div className="gen">
                <div className="kicker">Chronicle</div>
                <h2 className="gen__h">Nothing has happened yet.</h2>
              </div>
            </div>
          ))}

        {screen === "intake" && <Intake initial={lastInput} onDraw={draw} />}

        {screen === "generating" && (
          <Generating
            goal={lastInput?.goal ?? ""}
            phase={phase}
            error={genError}
            onRetry={() => lastInput && draw(lastInput)}
            onBack={cancelDraw}
          />
        )}
      </main>
    </div>
  );
}
