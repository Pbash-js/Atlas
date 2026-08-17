import type { AtlasNode, Edge } from "../schema/atlas";

/**
 * Rank layout, ported from atlas-card-catalogue.dc.html.
 *
 * This replaces dagre. The design needs three things dagre does not give us: ranks as a first-class
 * output (chapters are derived from them), recoveries held out of the ranking entirely, and rows
 * centred on a shared span so the plan reads as a column rather than a tree. All three fall out of
 * doing the longest-path ranking by hand, and it is about thirty lines.
 */

export const NODE_W = 258;
export const NODE_H = 132;
export const TERM_W = 172;
export const TERM_H = 62;
export const GAP_X = 54;
export const GAP_Y = 96;
export const CHAPTER_GAP = 104;
export const RANKS_PER_CHAPTER = 2;

export const START_ID = "__start";
export const FINISH_ID = "__finish";

export interface Pos {
  x: number;
  y: number;
  term?: boolean;
}

export interface Layout {
  pos: Map<string, Pos>;
  rank: Map<string, number>;
  rowY: Map<number, number>;
  ranks: number[];
  spanW: number;
  centreX: number;
  /** recovery id → the unit whose failure produced it */
  recoveryOf: Map<string, string>;
}

/** Longest-path ranking over the planning subgraph, with recoveries excluded. */
function ranksOf(nodes: AtlasNode[], edges: Edge[]) {
  const recoveryOf = new Map<string, string>();
  for (const e of edges) {
    if (e.type === "on_fail") recoveryOf.set(e.to, e.from);
  }

  const ranked = nodes.filter((n) => !recoveryOf.has(n.id)).map((n) => n.id);
  const inPlan = new Set(ranked);
  const planning = edges.filter(
    (e) => (e.type === "requires" || e.type === "then") && inPlan.has(e.from) && inPlan.has(e.to),
  );

  const rank = new Map<string, number>(ranked.map((id) => [id, 0]));
  for (let i = 0; i < ranked.length; i++) {
    let changed = false;
    for (const e of planning) {
      const next = (rank.get(e.from) ?? 0) + 1;
      if (next > (rank.get(e.to) ?? 0)) {
        rank.set(e.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  return { rank, recoveryOf, planning };
}

export function layoutGraph(nodes: AtlasNode[], edges: Edge[]): Layout {
  const { rank, recoveryOf, planning } = ranksOf(nodes, edges);

  const rows = new Map<number, string[]>();
  rank.forEach((r, id) => {
    const row = rows.get(r);
    if (row) row.push(id);
    else rows.set(r, [id]);
  });

  const ranks = [...rows.keys()].sort((a, b) => a - b);
  const widest = ranks.reduce((max, r) => Math.max(max, rows.get(r)?.length ?? 0), 0);
  const spanW = widest * NODE_W + (widest - 1) * GAP_X;

  const pos = new Map<string, Pos>();
  const rowY = new Map<number, number>();

  for (const r of ranks) {
    const row = rows.get(r);
    if (!row) continue;

    // Order each row by the mean x of its already-placed prerequisites, which is what keeps
    // edges from crossing the whole width of the plan.
    if (r > 0) {
      const bary = new Map<string, number>(
        row.map((id) => {
          const xs = planning
            .filter((e) => e.to === id && pos.has(e.from))
            .map((e) => pos.get(e.from)!.x);
          const mean = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.MAX_SAFE_INTEGER;
          return [id, mean];
        }),
      );
      row.sort((a, b) => (bary.get(a) ?? 0) - (bary.get(b) ?? 0));
    }

    const total = row.length * NODE_W + (row.length - 1) * GAP_X;
    const startX = 48 + (spanW - total) / 2;
    const y =
      48 + TERM_H + 96 + r * (NODE_H + GAP_Y) + Math.floor(r / RANKS_PER_CHAPTER) * CHAPTER_GAP;

    rowY.set(r, y);
    row.forEach((id, i) => pos.set(id, { x: startX + i * (NODE_W + GAP_X), y }));
  }

  // Recoveries sit beside the unit that produced them — an excursion off the path, not a rank on it.
  recoveryOf.forEach((unitId, recoveryId) => {
    const anchor = pos.get(unitId);
    if (anchor) pos.set(recoveryId, { x: anchor.x + NODE_W + 72, y: anchor.y + 22 });
  });

  const centreX = 48 + spanW / 2;
  const lastRank = ranks[ranks.length - 1];
  const lastY = lastRank === undefined ? 0 : (rowY.get(lastRank) ?? 0);

  pos.set(START_ID, { x: centreX - TERM_W / 2, y: 48, term: true });
  pos.set(FINISH_ID, { x: centreX - TERM_W / 2, y: lastY + NODE_H + 96, term: true });

  return { pos, rank, rowY, ranks, spanW, centreX, recoveryOf };
}

export interface Bounds {
  minX: number;
  minY: number;
  w: number;
  h: number;
}

export function boundsOf(pos: Map<string, Pos>): Bounds {
  if (!pos.size) return { minX: 0, minY: 0, w: 1000, h: 800 };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  pos.forEach((p) => {
    const w = p.term ? TERM_W : NODE_W;
    const h = p.term ? TERM_H : NODE_H;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + w);
    maxY = Math.max(maxY, p.y + h);
  });

  return { minX, minY, w: maxX - minX, h: maxY - minY };
}
