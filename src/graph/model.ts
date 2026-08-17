import type { AtlasGraph, AtlasNode } from "../schema/atlas";
import { boundsOf, layoutGraph, type Bounds, type Layout } from "./layout";
import { deriveChapters, type ChapterView } from "./chapters";
import { numberNodes } from "./numbering";

/**
 * Everything derived from a graph for one render of the plan screen. Built once and shared by the
 * canvas and the panel — both need chapters and card numbers, and laying the graph out twice per
 * render would be the obvious way to make this feel slow.
 */
export interface PlanModel {
  layout: Layout;
  chapters: ChapterView;
  nums: Map<string, string>;
  bounds: Bounds;
  byId: Map<string, AtlasNode>;
  units: AtlasNode[];
  passed: number;
  pct: number;
  bankedMinutes: number;
}

export function buildPlanModel(graph: AtlasGraph, arabic = false): PlanModel {
  const layout = layoutGraph(graph.nodes, graph.edges);
  const chapters = deriveChapters(graph, layout);
  const nums = numberNodes(graph, arabic);
  const bounds = boundsOf(layout.pos);
  const byId = new Map<string, AtlasNode>(graph.nodes.map((n) => [n.id, n]));

  const units = graph.nodes.filter((n) => n.type === "UNIT");
  const passed = units.filter((n) => n.status === "passed").length;
  const pct = units.length ? Math.round((passed / units.length) * 100) : 0;
  const bankedMinutes = graph.events.reduce((sum, e) => sum + (e.minutes ?? 0), 0);

  return { layout, chapters, nums, bounds, byId, units, passed, pct, bankedMinutes };
}
