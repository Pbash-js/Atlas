import type { AtlasGraph } from "../schema/atlas";
import { numeral } from "../lib/format";

/**
 * Card numbers, per atlas-card-catalogue.dc.html. Plan nodes are numbered in document order;
 * a recovery is not given a number of its own but takes its parent's with a `·r` suffix, because
 * it is an excursion off that card rather than the next card in the sequence.
 */
export function numberNodes(graph: AtlasGraph, arabic = false): Map<string, string> {
  const nums = new Map<string, string>();

  let i = 0;
  for (const node of graph.nodes) {
    if (node.type === "RECOVERY") continue;
    nums.set(node.id, numeral(i, arabic));
    i++;
  }

  for (const edge of graph.edges) {
    if (edge.type !== "on_fail") continue;
    nums.set(edge.to, `${nums.get(edge.from) ?? ""}·r`);
  }

  return nums;
}
