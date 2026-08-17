import { readFileSync, writeFileSync } from "node:fs";
import { architect, type Phase } from "../src/llm/architect";
import { GeminiModel } from "../src/llm/model";
import { validateGraph } from "../src/schema/validate";
import { buildPlanModel } from "../src/graph/model";
import { fmt } from "../src/lib/format";

/**
 * End-to-end journey against the live model: a stated goal in, a validated plan out.
 * Run: npx tsx scripts/journey.ts "I want to start content creation"
 */

function keyFromFloEnv(): string {
  const env = readFileSync("X:/1-Projects/Flo~/src-tauri/.env", "utf8");
  const m = env.match(/FLO_DEFAULT_GEMINI_KEY=(.+)/);
  if (!m?.[1]) throw new Error("no key found");
  return m[1].trim();
}

const goal = process.argv[2] ?? "I want to start content creation";
const hours = process.argv[3] ?? "6 hrs";

const model = new GeminiModel(keyFromFloEnv());
const started = Date.now();

const onPhase = (p: Phase) => {
  const t = ((Date.now() - started) / 1000).toFixed(1).padStart(5);
  if (p.step === "repairing") {
    console.log(`  ${t}s  repairing (attempt ${p.attempt})`);
    for (const problem of p.problems) console.log(`         ↳ ${problem}`);
  } else {
    console.log(`  ${t}s  ${p.step}${"attempt" in p ? ` (attempt ${p.attempt})` : ""}`);
  }
};

console.log(`\n  GOAL: ${goal}\n  TIME: ${hours}/week\n`);

architect(model, { goal, weeklyHours: hours, known: "" }, onPhase)
  .then(({ graph, attempts, warnings }) => {
    const check = validateGraph(graph);
    if (!check.ok) throw new Error("architect returned an invalid graph");

    const m = buildPlanModel(graph);
    const incoming = new Map<string, number>();
    for (const e of graph.edges) {
      if (e.type !== "requires") continue;
      incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
    }
    const convergent = [...incoming.values()].filter((n) => n >= 2).length;
    const total = m.units.reduce((s, n) => s + (n.type === "UNIT" ? n.estimate_min : 0), 0);

    console.log(`\n  VALID after ${attempts} attempt(s), ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
    console.log(`    terminal capability  ${graph.goal.terminal_capability}`);
    console.log(`    nodes                ${graph.nodes.length}`);
    console.log(`    edges                ${graph.edges.length}`);
    console.log(`    convergent           ${convergent}`);
    console.log(`    chapters             ${m.chapters.chapters.map((c) => c.title).join(" · ")}`);
    console.log(`    ready at start       ${graph.nodes.filter((n) => n.status === "ready").length}`);
    console.log(`    effort               ${fmt(total)}`);
    console.log(`    warnings             ${warnings.length}`);

    console.log(`\n  FIRST FOUR CARDS\n`);
    for (const n of graph.nodes.slice(0, 4)) {
      if (n.type !== "UNIT") continue;
      console.log(`    ${n.title}  [${n.kind}, ${fmt(n.estimate_min)}, ${n.status}]`);
      console.log(`      why: ${n.why}`);
      console.log(`      check (${n.exit_check.evidence}): ${n.exit_check.prompt}`);
      for (const r of n.exit_check.rubric) console.log(`        · ${r}`);
      console.log("");
    }

    writeFileSync("fixtures/journey-output.json", JSON.stringify(graph, null, 2));
    console.log("  written to fixtures/journey-output.json\n");
  })
  .catch((err) => {
    console.error("\n  FAILED:", err instanceof Error ? err.message : err, "\n");
    process.exit(1);
  });
