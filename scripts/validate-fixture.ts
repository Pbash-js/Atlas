import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateGraph } from "../src/schema/validate";
import type { AtlasGraph } from "../src/schema/atlas";

/**
 * Phase 0's forcing function: run the hand-written golden graph through the real validator.
 * If the schema cannot express a graph a human wants, it will never survive a generated one.
 */

const target = process.argv[2] ?? "fixtures/golden-bs-streaming.json";
const path = resolve(process.cwd(), target);
const raw = JSON.parse(readFileSync(path, "utf8"));

const result = validateGraph(raw);

console.log(`\n  ${target}\n`);

if (result.errors.length) {
  console.log("  errors");
  for (const e of result.errors) {
    console.log(`    x [${e.code}] ${e.message}`);
  }
  console.log("");
}

if (result.warnings.length) {
  console.log("  warnings");
  for (const w of result.warnings) {
    console.log(`    ! [${w.code}] ${w.message}`);
  }
  console.log("");
}

if (result.ok && result.graph) {
  const g: AtlasGraph = result.graph;
  const units = g.nodes.filter((n) => n.type === "UNIT");
  const recoveries = g.nodes.filter((n) => n.type === "RECOVERY");
  const decisions = g.nodes.filter((n) => n.type === "DECISION");

  const incoming = new Map<string, number>();
  for (const e of g.edges) {
    if (e.type !== "requires") continue;
    incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
  }
  const convergent = [...incoming.entries()].filter(([, n]) => n >= 2);

  const byType = (t: string) => g.edges.filter((e) => e.type === t).length;
  const totalMin = units.reduce((sum, n) => sum + (n.type === "UNIT" ? n.estimate_min : 0), 0);

  console.log("  VALID\n");
  console.log(`    nodes         ${g.nodes.length}  (${units.length} unit, ${recoveries.length} recovery, ${decisions.length} decision)`);
  console.log(`    edges         ${g.edges.length}  (${byType("requires")} requires, ${byType("then")} then, ${byType("on_fail")} on_fail, ${byType("if")} if)`);
  console.log(`    convergent    ${convergent.length} nodes with 2+ prerequisites`);
  console.log(`    est. effort   ${(totalMin / 60).toFixed(1)}h across all units`);
  console.log(`    events        ${g.events.length}`);
  console.log(`    mutations     ${g.mutations.length}`);
  console.log("");
} else {
  console.log("  INVALID\n");
  process.exit(1);
}
