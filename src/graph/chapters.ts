import type { AtlasGraph, AtlasNode } from "../schema/atlas";
import { CHAPTER_GAP, RANKS_PER_CHAPTER, type Layout } from "./layout";

/**
 * Chapters, per atlas-card-catalogue.dc.html.
 *
 * A chapter is a run of RANKS_PER_CHAPTER ranks. It **seals** when every unit inside it has passed,
 * and the next chapter stays **shut** until the one before it seals. This is a second gate sitting
 * on top of `requires`: a node can have every prerequisite satisfied and still be barred because
 * its chapter has not opened.
 *
 * Nothing here is persisted — chapters are derived from ranks on every render, so the schema is
 * untouched and a regenerated graph re-chapters itself.
 */

/**
 * Last-resort chapter names. A generated graph authors its own into `graph.chapters`; these are
 * only reached for a graph that predates that field.
 */
export const FALLBACK_CHAPTER_TITLES = ["Foundations", "The middle", "The work", "The reckoning", "Coda"];

export interface Chapter {
  i: number;
  ids: string[];
  units: number;
  passed: number;
  sealed: boolean;
  open: boolean;
  y: number;
  title: string;
}

export interface ChapterView {
  chapters: Chapter[];
  /** node id → chapter index */
  chapterOf: Map<string, number>;
  /** true when the node's chapter has not opened yet */
  isGated: (id: string) => boolean;
}

export function deriveChapters(graph: AtlasGraph, layout: Layout): ChapterView {
  const byId = new Map<string, AtlasNode>(graph.nodes.map((n) => [n.id, n]));

  // A recovery inherits the chapter of the unit it hangs off, since it has no rank of its own.
  const chapterOf = new Map<string, number>();
  for (const node of graph.nodes) {
    let r = layout.rank.get(node.id);
    if (r === undefined) {
      const source = layout.recoveryOf.get(node.id);
      r = source === undefined ? 0 : (layout.rank.get(source) ?? 0);
    }
    chapterOf.set(node.id, Math.floor(r / RANKS_PER_CHAPTER));
  }

  const count = Math.max(0, ...chapterOf.values()) + 1;
  const chapters: Chapter[] = [];

  for (let i = 0; i < count; i++) {
    const ids = graph.nodes.filter((n) => chapterOf.get(n.id) === i).map((n) => n.id);
    const units = ids
      .map((id) => byId.get(id))
      .filter((n): n is AtlasNode => Boolean(n))
      .filter((n) => n.type === "UNIT");
    const passed = units.filter((n) => n.status === "passed").length;

    const ranks = ids
      .map((id) => layout.rank.get(id))
      .filter((r): r is number => r !== undefined);
    const topRank = ranks.length ? Math.min(...ranks) : 0;

    chapters.push({
      i,
      ids,
      units: units.length,
      passed,
      sealed: units.length > 0 && passed === units.length,
      open: false,
      y: (layout.rowY.get(topRank) ?? 0) - CHAPTER_GAP / 2 - 16,
      title: graph.chapters[i] ?? FALLBACK_CHAPTER_TITLES[i] ?? `Chapter ${i + 1}`,
    });
  }

  // The first chapter is always open; every later one waits on its predecessor's seal.
  chapters.forEach((c, i) => {
    const prev = chapters[i - 1];
    c.open = i === 0 ? true : Boolean(prev?.sealed);
  });

  const isGated = (id: string) => {
    const c = chapters[chapterOf.get(id) ?? 0];
    return c ? !c.open : false;
  };

  return { chapters, chapterOf, isGated };
}
