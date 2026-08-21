/**
 * Transient messages shown above the chat bar.
 *
 * These replace the original design's `chatLog`, which appended a line and never removed it —
 * there was no dismiss control and no expiry, so a couple of clicks left permanent text sitting
 * over the canvas. A notice now carries its own status and is always dismissible; successes
 * retire themselves, and only failures wait to be read.
 */

export type NoticeStatus = "pending" | "ok" | "error";

export interface Notice {
  id: string;
  status: NoticeStatus;
  text: string;
}

/** How long a finished notice stays before retiring itself. Errors never auto-retire. */
export const NOTICE_TTL_MS = 6000;

let counter = 0;
export function noticeId(): string {
  counter += 1;
  return `notice_${counter}`;
}
