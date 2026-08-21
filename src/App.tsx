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
  addManualResource,
  listPlans,
  savePlan,
  seedOnce,
  markPassed,
  setNodeResources,
  touchPlan,
  type StoredPlan,
} from "./store/plans";
import { architect, type ArchitectInput, type Phase } from "./llm/architect";
import { findResources } from "./llm/librarian";
import { mutate, type MutationIntent } from "./llm/mutator";
import { applyPatch } from "./graph/mutate";
import { validateGraph } from "./schema/validate";
import { GeminiModel } from "./llm/model";
import { isHttpUrl, isReachable, titleFromUrl } from "./resources/verify";
import { fmt, numeral } from "./lib/format";
import { noticeId, NOTICE_TTL_MS, type Notice } from "./lib/notice";
import type { QuizState } from "./panel/NodeDetail";
import { QuizModal } from "./panel/QuizModal";
import { generateQuiz, generatePlanQuiz, assess } from "./llm/examiner";
import { PASS_RATIO } from "./quiz/types";
import {
  applyResults,
  chooseFocus,
  emptyMastery,
  getMasteryStore,
  type NodeMastery,
} from "./quiz/mastery";
import { fingerprintOf, getQuizCache, isUsable, newEntry } from "./quiz/cache";
import { TestKnowledge } from "./screens/TestKnowledge";
import {
  chooseCards,
  eligibleCards,
  namespaceId,
  splitId,
  planQuizKey,
  PLAN_QUIZ_PER_CARD,
  type MasteryMap,
} from "./quiz/planquiz";

type Screen = "home" | "plan" | "chronicle" | "test" | "intake" | "generating";
type Ground = "dark" | "soft";

const VIEWS: { key: Screen; label: string }[] = [
  { key: "home", label: "Room" },
  { key: "plan", label: "Plan" },
  { key: "chronicle", label: "Chronicle" },
  { key: "test", label: "Test" },
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

  const [addingId, setAddingId] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  const [notices, setNotices] = useState<Notice[]>([]);
  const [acting, setActing] = useState(false);

  const [quiz, setQuiz] = useState<QuizState | null>(null);
  const [quizLoading, setQuizLoading] = useState(false);
  const [quizError, setQuizError] = useState<string | null>(null);
  const [mastery, setMastery] = useState<NodeMastery | null>(null);
  const [quizResumable, setQuizResumable] = useState(false);
  const [masteries, setMasteries] = useState<MasteryMap>(new Map());
  const [planQuizLoading, setPlanQuizLoading] = useState(false);
  const [planQuizError, setPlanQuizError] = useState<string | null>(null);

  /** How many questions a quiz asks. Short enough to actually finish in one sitting. */
  const QUIZ_LENGTH = 5;

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

  /**
   * The hand-off path: the user opened Google AI Mode themselves, found a link, and pasted it
   * back. There is no Gemini call in this path at all — checking reachability and writing the
   * resource are both purely local, which is what makes this work with no key and no quota.
   */
  const handleAddResource = useCallback(
    async (nodeId: string, rawUrl: string): Promise<boolean> => {
      const plan = current;
      if (!plan) return false;

      const url = rawUrl.trim();
      if (!isHttpUrl(url)) {
        setAddError("That doesn't look like a link.");
        return false;
      }

      setAddError(null);
      setAddingId(nodeId);
      try {
        const reachable = await isReachable(url);
        if (!reachable) {
          setAddError("Could not reach that link. Check it, or add it anyway if you're sure.");
          return false;
        }
        const today = new Date().toISOString().slice(0, 10);
        addManualResource(plan.graph, nodeId, {
          url,
          title: titleFromUrl(url),
          kind: "text",
          minutes: 20,
          cost: 0,
          verified: today,
          status: "ok",
        });
        setPlans(listPlans());
        return true;
      } finally {
        setAddingId(null);
      }
    },
    [current],
  );

  /** The "add it anyway" escape hatch for a false-negative reachability check — see verify.ts. */
  const handleAddResourceForced = useCallback(
    (nodeId: string, rawUrl: string) => {
      const plan = current;
      const url = rawUrl.trim();
      if (!plan || !isHttpUrl(url)) return;

      setAddError(null);
      addManualResource(plan.graph, nodeId, {
        url,
        title: titleFromUrl(url),
        kind: "text",
        minutes: 20,
        cost: 0,
        verified: null,
        status: "unverified",
      });
      setPlans(listPlans());
    },
    [current],
  );

  const dismissNotice = useCallback((id: string) => {
    setNotices((prev) => prev.filter((n) => n.id !== id));
  }, []);

  /** Settle a pending notice in place, and let successes retire themselves. */
  const settleNotice = useCallback((id: string, status: "ok" | "error", text: string) => {
    setNotices((prev) => prev.map((n) => (n.id === id ? { ...n, status, text } : n)));
    if (status === "ok") {
      setTimeout(() => {
        setNotices((prev) => prev.filter((n) => n.id !== id));
      }, NOTICE_TTL_MS);
    }
  }, []);

  const LABELS: Record<string, string> = {
    edit_node: "Revising the card",
    rewrite_check: "Rewriting the exit check",
    insert_prereq: "Looking for the missing prerequisite",
    insert_recovery: "Drafting a recovery",
    prune_node: "Weighing whether it earns its place",
    explain: "Putting it more simply",
    insert_unit: "Drafting a new card",
    retitle_chapters: "Naming the chapters",
    ask: "Reading the plan",
    reshape: "Redrawing the plan",
  };

  /**
   * Every context-menu action and every chat ask lands here.
   *
   * A patch is applied to a copy, validated, and only then persisted — so a model that returns
   * something structurally legal but graph-breaking (a cycle, say) is refused rather than saved.
   */
  const handleAction = useCallback(
    async (intent: MutationIntent | { kind: "reshape" }) => {
      const plan = current;
      if (!plan || acting) return;

      const id = noticeId();
      setNotices((prev) => [
        ...prev.filter((n) => n.status !== "pending"),
        { id, status: "pending", text: `${LABELS[intent.kind] ?? "Working"}…` },
      ]);
      setActing(true);

      try {
        if (intent.kind === "reshape") {
          // Reshape is a re-derivation, not a patch — and it is deliberately NON-DESTRUCTIVE.
          // The redrawn plan is saved as a separate record, so a structure you liked better is
          // still sitting in the reading room afterwards.
          const passed = plan.graph.nodes
            .filter((n) => n.status === "passed")
            .map((n) => n.title);
          const result = await architect(
            model,
            {
              goal: plan.graph.goal.statement,
              weeklyHours: lastInput?.weeklyHours ?? "6 hrs",
              known: passed.join("\n"),
            },
            // Reshape reports through its notice rather than the generation screen, so the
            // per-phase callback has nothing to drive here.
            () => {},
          );
          const saved = savePlan(result.graph);
          setPlans(listPlans());
          setPlanId(saved.id);
          setSelectedId(openingNode(saved));
          settleNotice(
            id,
            "ok",
            `Redrawn as a new plan — ${result.graph.nodes.length} cards. The original is still in the reading room.`,
          );
          return;
        }

        const outcome = await mutate(model, plan.graph, intent);

        if (outcome.type === "answer") {
          settleNotice(id, "ok", outcome.text);
          return;
        }

        const next = applyPatch(plan.graph, outcome.patch, `r_mutate_${Date.now().toString(36)}`);
        const check = validateGraph(next);
        if (!check.ok || !check.graph) {
          settleNotice(
            id,
            "error",
            `That change would have broken the plan, so nothing moved. ${check.errors[0]?.message ?? ""}`,
          );
          return;
        }

        savePlan(check.graph);
        setPlans(listPlans());
        if (outcome.patch.op === "prune_node" && selectedId === outcome.patch.target) {
          setSelectedId(null);
        }
        settleNotice(id, "ok", outcome.patch.reason);
      } catch (err) {
        settleNotice(id, "error", err instanceof Error ? err.message : String(err));
      } finally {
        setActing(false);
      }
    },
    [current, acting, lastInput, selectedId, settleNotice],
  );

  // Mastery is per card, so it reloads whenever the selection moves — through the store
  // interface, never localStorage directly, so an injected store is picked up here for free.
  useEffect(() => {
    let live = true;
    if (!selectedId) {
      setMastery(null);
      return;
    }
    void getMasteryStore()
      .load(selectedId)
      .then((m) => {
        if (live) setMastery(m ?? emptyMastery(selectedId));
      });
    return () => {
      live = false;
    };
  }, [selectedId, quiz]);

  // Does an un-submitted quiz still match this card? Drives the "Resume quiz" affordance, so the
  // cache is visible rather than a silent surprise.
  useEffect(() => {
    let live = true;
    const target = current?.graph.nodes.find((n) => n.id === selectedId);
    if (!selectedId || !target || target.type === "DECISION" || !mastery) {
      setQuizResumable(false);
      return;
    }
    void getQuizCache()
      .load(selectedId)
      .then((cached) => {
        if (live) setQuizResumable(isUsable(cached, fingerprintOf(target, mastery)));
      });
    return () => {
      live = false;
    };
  }, [selectedId, mastery, current, quiz]);

  /**
   * Mastery for every card in the plan, for the plan-wide test screen. Reloaded whenever the
   * graph changes or a quiz settles, so the pool and its grasp bars never show stale numbers.
   */
  useEffect(() => {
    let live = true;
    if (!current) {
      setMasteries(new Map());
      return;
    }
    const store = getMasteryStore();
    const ids = current.graph.nodes.filter((n) => n.type !== "DECISION").map((n) => n.id);
    void Promise.all(ids.map(async (id) => [id, await store.load(id)] as const)).then((pairs) => {
      if (live) setMasteries(new Map(pairs));
    });
    return () => {
      live = false;
    };
  }, [current, quiz]);

  /**
   * Build a plan-wide test: choose the cards, then generate each card's questions in parallel and
   * merge them. Question ids are namespaced by card, because two cards will both call their first
   * question "q1" and marking keys on the id.
   */
  const handleStartPlanTest = useCallback(async () => {
    const plan = current;
    if (!plan || planQuizLoading) return;

    const chosen = chooseCards(eligibleCards(plan.graph, masteries));
    if (chosen.length === 0) return;

    setPlanQuizError(null);
    setPlanQuizLoading(true);
    try {
      const byId = new Map(plan.graph.nodes.map((n) => [n.id, n]));
      const requests = chosen.flatMap((card) => {
        const node = byId.get(card.nodeId);
        if (!node || node.type === "DECISION") return [];
        const existing = card.mastery ?? emptyMastery(card.nodeId);
        return [
          {
            node,
            goalStatement: plan.graph.goal.statement,
            mastery: existing,
            focus: chooseFocus(existing, PLAN_QUIZ_PER_CARD),
            count: PLAN_QUIZ_PER_CARD,
          },
        ];
      });

      const generated = await generatePlanQuiz(model, requests);
      const questions = generated.flatMap(({ nodeId, questions: qs }) =>
        qs.map((q) => ({ ...q, id: namespaceId(nodeId, q.id) })),
      );

      setQuiz({
        nodeId: planQuizKey(plan.id),
        questions,
        answers: {},
        results: null,
        marking: false,
      });
    } catch (err) {
      setPlanQuizError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanQuizLoading(false);
    }
  }, [current, masteries, planQuizLoading]);

  const handleTakeQuiz = useCallback(
    async (nodeId: string, opts?: { fresh?: boolean }) => {
      const plan = current;
      const target = plan?.graph.nodes.find((n) => n.id === nodeId);
      if (!plan || !target || target.type === "DECISION") return;

      setQuizError(null);
      const existing = (await getMasteryStore().load(nodeId)) ?? emptyMastery(nodeId);
      const fingerprint = fingerprintOf(target, existing);
      const cache = getQuizCache();

      // A cached quiz is only served when nothing that shapes the questions has moved since it
      // was written — see fingerprintOf. Submitting one advances mastery, so the next request
      // misses on purpose and is generated fresh against what was just got wrong.
      if (!opts?.fresh) {
        const cached = await cache.load(nodeId);
        if (isUsable(cached, fingerprint)) {
          setQuiz({
            nodeId,
            questions: cached.questions,
            answers: cached.answers,
            results: null,
            marking: false,
            fromCache: true,
          });
          return;
        }
      }

      setQuizLoading(true);
      try {
        const focus = chooseFocus(existing, QUIZ_LENGTH);
        const questions = await generateQuiz(model, {
          node: target,
          goalStatement: plan.graph.goal.statement,
          mastery: existing,
          focus,
          count: QUIZ_LENGTH,
        });
        await cache.save(newEntry(nodeId, fingerprint, questions));
        setQuiz({ nodeId, questions, answers: {}, results: null, marking: false });
      } catch (err) {
        setQuizError(err instanceof Error ? err.message : String(err));
      } finally {
        setQuizLoading(false);
      }
    },
    [current],
  );

  /** Persist answers as they are typed, so setting a quiz aside loses nothing. */
  const handleQuizAnswersChange = useCallback(
    async (nodeId: string, answers: Record<string, string>) => {
      const cache = getQuizCache();
      const cached = await cache.load(nodeId);
      if (!cached) return;
      await cache.save({ ...cached, answers });
    },
    [],
  );

  const handleSubmitQuiz = useCallback(
    async (nodeId: string, answers: Record<string, string>) => {
      const plan = current;
      if (!plan || !quiz || quiz.nodeId !== nodeId) return;

      setQuiz({ ...quiz, marking: true });
      setQuizError(null);
      setPlanQuizError(null);
      try {
        const results = await assess(model, quiz.questions, answers);
        const store = getMasteryStore();

        // A plan-wide test carries questions from several cards, so results are grouped by the
        // card their question id was namespaced with and each card's mastery is updated
        // separately. A single-card quiz is just the one-group case of the same thing.
        const isPlanTest = nodeId.startsWith(`plan${"::"}`);
        const grouped = new Map<string, { concept: string; correct: boolean }[]>();

        for (const r of results) {
          const owner = isPlanTest ? splitId(r.question.id).nodeId : nodeId;
          if (!owner) continue;
          grouped.set(owner, [
            ...(grouped.get(owner) ?? []),
            { concept: r.question.concept, correct: r.correct },
          ]);
        }

        // Record what was learned before anything else, so a failure to update card statuses
        // cannot cost the learner their mastery history.
        let graph = plan.graph;
        let statusesMoved = false;

        for (const [owner, graded] of grouped) {
          const existing = (await store.load(owner)) ?? emptyMastery(owner);
          const updated = applyResults(existing, graded);
          await store.save(updated);
          if (owner === selectedId) setMastery(updated);

          const ratio = graded.filter((g) => g.correct).length / (graded.length || 1);
          const node = graph.nodes.find((n) => n.id === owner);
          if (ratio >= PASS_RATIO && node && node.status !== "passed") {
            graph = markPassed(graph, owner);
            statusesMoved = true;
          }
        }

        if (statusesMoved) {
          savePlan(graph);
          setPlans(listPlans());
        }

        // A marked quiz is spent. Clearing it here is belt-and-braces — the mastery update alone
        // already moves the fingerprint — but it means a stale entry never lingers in storage.
        await getQuizCache().clear(nodeId);
        setQuiz({ nodeId, questions: quiz.questions, results, marking: false });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setQuiz({ ...quiz, marking: false });
        // Route to whichever error the open modal is actually reading, or the failure is silent.
        if (nodeId.startsWith("plan::")) setPlanQuizError(message);
        else setQuizError(message);
      }
    },
    [current, quiz, selectedId],
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

  // The modal is titled by the card it belongs to, which is not necessarily the selected one —
  // the quiz stays open and correctly labelled even if the selection moves behind it.
  const isPlanTest = Boolean(quiz && quiz.nodeId.startsWith("plan::"));
  const quizNode = quiz ? (current?.graph.nodes.find((n) => n.id === quiz.nodeId) ?? null) : null;
  const quizChapter = quiz ? planModel?.chapters.chapterOf.get(quiz.nodeId) : undefined;
  const quizChapterLabel =
    quizChapter !== undefined && planModel
      ? `Chapter ${numeral(quizChapter, ARABIC)} · ${planModel.chapters.chapters[quizChapter]?.title ?? ""}`
      : "";
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
                disabled={
                  (v.key === "plan" || v.key === "chronicle" || v.key === "test") && !current
                }
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
                onAction={handleAction}
                notices={notices}
                onDismissNotice={dismissNotice}
                busy={acting}
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
                onAddResource={handleAddResource}
                onAddResourceForced={handleAddResourceForced}
                addingId={addingId}
                addError={addError}
                onTakeQuiz={handleTakeQuiz}
                quizOpen={quiz?.nodeId === selectedId}
                quizResumable={quizResumable}
                quizLoading={quizLoading}
                quizError={quizError}
                mastery={mastery}
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

        {screen === "test" &&
          (current ? (
            <TestKnowledge
              graph={current.graph}
              masteries={masteries}
              loading={planQuizLoading}
              error={planQuizError}
              onStart={handleStartPlanTest}
              onOpenNode={openNode}
            />
          ) : (
            <div className="scroll">
              <div className="gen">
                <div className="kicker">Test your knowledge</div>
                <h2 className="gen__h">There is no plan to test yet.</h2>
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

      {quiz && (quizNode || isPlanTest) && (
        <QuizModal
          key={`${quiz.nodeId}:${quiz.questions.map((q) => q.id).join(",")}`}
          title={isPlanTest ? (current?.graph.goal.statement ?? "The whole plan") : (quizNode?.title ?? "")}
          chapter={isPlanTest ? "Test your knowledge · the whole plan" : quizChapterLabel}
          questions={quiz.questions}
          results={quiz.results}
          marking={quiz.marking}
          error={isPlanTest ? planQuizError : quizError}
          initialAnswers={quiz.answers}
          onAnswersChange={(answers) => handleQuizAnswersChange(quiz.nodeId, answers)}
          onSubmit={(answers) => handleSubmitQuiz(quiz.nodeId, answers)}
          onClose={() => setQuiz(null)}
          onRetake={() => (isPlanTest ? handleStartPlanTest() : handleTakeQuiz(quiz.nodeId))}
        />
      )}
    </div>
  );
}
