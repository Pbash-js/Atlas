import type { EdgeType } from "../schema/atlas";
import { C } from "../lib/format";

/**
 * Edge presentation, per atlas-card-catalogue.dc.html. The `note` is what the edge says about
 * itself on hover — the only place the graph explains its own semantics to the reader.
 */
export interface EdgeStyle {
  stroke: string;
  width: number;
  dash: string | null;
  note: string;
}

export function edgeStyle(type: EdgeType, strength: number): EdgeStyle {
  switch (type) {
    case "requires":
      return strength < 0.6
        ? { stroke: C("--at-rule-soft"), width: 1, dash: null, note: "weak prerequisite" }
        : { stroke: C("--at-rule"), width: 1.25, dash: null, note: "prerequisite" };
    case "then":
      return { stroke: C("--at-rule-soft"), width: 1, dash: "2 7", note: "suggested order" };
    case "on_fail":
      return { stroke: C("--at-failed"), width: 1.25, dash: "5 5", note: "failure route" };
    case "if":
      return { stroke: C("--at-gold"), width: 1.15, dash: "7 5", note: "condition" };
  }
}

/** Rank-to-rank: straight when columns align, otherwise a vertical S-curve. */
export const pathV = (sx: number, sy: number, tx: number, ty: number) =>
  Math.abs(tx - sx) < 2
    ? `M${sx},${sy} L${tx},${ty}`
    : `M${sx},${sy} C${sx},${(sy + ty) / 2} ${tx},${(sy + ty) / 2} ${tx},${ty}`;

/** Failure routes leave the side of a card, so they need a horizontal departure. */
export const pathH = (sx: number, sy: number, tx: number, ty: number) =>
  `M${sx},${sy} C${sx + 46},${sy} ${tx},${sy} ${tx},${ty}`;
