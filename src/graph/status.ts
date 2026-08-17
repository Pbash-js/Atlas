import type { NodeStatus } from "../schema/atlas";

/**
 * Status presentation, per atlas-card-catalogue.dc.html.
 *
 * `locked` deliberately carries no glyph — the design draws a padlock icon for it instead, so
 * that the one state meaning "you may not start this" is the one state that is not a dot.
 */
export interface StatusMeta {
  glyph: string;
  label: string;
  /** CSS custom property holding this status's colour. */
  token: string;
}

export const ST: Record<NodeStatus, StatusMeta> = {
  passed: { glyph: "◈", label: "passed", token: "--at-passed" },
  in_progress: { glyph: "◐", label: "in progress", token: "--at-progress" },
  failed: { glyph: "✕", label: "failed", token: "--at-failed" },
  bounced: { glyph: "✕", label: "bounced", token: "--at-failed" },
  ready: { glyph: "○", label: "ready", token: "--at-ready" },
  locked: { glyph: "", label: "locked", token: "--at-locked" },
  skipped: { glyph: "»", label: "skipped", token: "--at-locked" },
  pruned: { glyph: "–", label: "pruned", token: "--at-locked" },
};

/** Fallback glyph for list rows, where an empty mark would collapse the layout. */
export const glyphOr = (status: NodeStatus) => ST[status].glyph || "▫";
