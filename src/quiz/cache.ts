import type { UnitNode, RecoveryNode } from "../schema/atlas";
import type { NodeMastery } from "./mastery";
import { Question } from "./types";

/**
 * Caching for generated quizzes.
 *
 * The obvious version of this — "keep the questions, reuse them forever" — would quietly destroy
 * the adaptive behaviour it is meant to speed up. The point of the system is that the NEXT quiz
 * is different because you have learned something since the last one.
 *
 * So the cache is keyed on a FINGERPRINT of everything that legitimately changes the questions:
 * the card's own content, and the mastery state that drives which concepts get drilled. Reopening
 * a quiz you set aside is instant. Submitting one moves mastery, which moves the fingerprint,
 * which means the next quiz is generated fresh against what you just got wrong. Editing the card
 * does the same.
 *
 * In-progress answers ride along, so closing the panel or reloading the page does not throw away
 * work you have already done.
 */

/** Bump when the Question shape changes, so old cached quizzes are discarded rather than parsed. */
const CACHE_VERSION = 1;
const KEY_PREFIX = "atlas.quiz.";

export interface CachedQuiz {
  version: number;
  nodeId: string;
  fingerprint: string;
  questions: Question[];
  answers: Record<string, string>;
  savedAt: string;
}

export interface QuizCache {
  load(nodeId: string): Promise<CachedQuiz | null>;
  save(entry: CachedQuiz): Promise<void>;
  clear(nodeId: string): Promise<void>;
}

/** FNV-1a. Short, stable, and dependency-free — this is a cache key, not a security boundary. */
function hash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Everything that should invalidate a cached quiz, and nothing that should not.
 *
 * Mastery contributes the concept names, each strength rounded to one decimal, and the quiz
 * count. Rounding matters: without it, floating-point noise would change the key on every write
 * and the cache would never hit. The quiz count guarantees a submitted quiz always invalidates,
 * even in the edge case where every answer left the strengths where they were.
 */
export function fingerprintOf(node: UnitNode | RecoveryNode, mastery: NodeMastery): string {
  const check = node.exit_check;
  const nodePart = [
    node.id,
    node.title,
    node.why,
    check?.evidence ?? "",
    check?.prompt ?? "",
    ...(check?.rubric ?? []),
  ].join("|");

  const masteryPart = [
    `q${mastery.quizzes}`,
    ...[...mastery.concepts]
      .sort((a, b) => a.concept.localeCompare(b.concept))
      .map((c) => `${c.concept}:${c.strength.toFixed(1)}`),
  ].join("|");

  return hash(`${nodePart}##${masteryPart}`);
}

export const localQuizCache: QuizCache = {
  async load(nodeId) {
    try {
      const raw = localStorage.getItem(KEY_PREFIX + nodeId);
      if (!raw) return null;

      const parsed = JSON.parse(raw) as CachedQuiz;
      if (parsed?.version !== CACHE_VERSION) return null;

      // Re-validate the questions themselves: a cached quiz written by an older build could be
      // structurally stale in ways the version bump did not anticipate.
      const questions: Question[] = [];
      for (const candidate of parsed.questions ?? []) {
        const check = Question.safeParse(candidate);
        if (!check.success) return null;
        questions.push(check.data);
      }
      if (questions.length === 0) return null;

      return { ...parsed, questions, answers: parsed.answers ?? {} };
    } catch {
      return null;
    }
  },

  async save(entry) {
    try {
      localStorage.setItem(KEY_PREFIX + entry.nodeId, JSON.stringify(entry));
    } catch {
      // Storage full or blocked: the quiz still works, it just will not be resumable.
    }
  },

  async clear(nodeId) {
    try {
      localStorage.removeItem(KEY_PREFIX + nodeId);
    } catch {
      // Best-effort by definition.
    }
  },
};

let active: QuizCache = localQuizCache;

/** Same override pattern as the mastery store, so both can move to a server together. */
export function setQuizCache(cache: QuizCache): void {
  active = cache;
}

export function getQuizCache(): QuizCache {
  return active;
}

export function resetQuizCache(): void {
  active = localQuizCache;
}

export function newEntry(
  nodeId: string,
  fingerprint: string,
  questions: Question[],
  answers: Record<string, string> = {},
): CachedQuiz {
  return {
    version: CACHE_VERSION,
    nodeId,
    fingerprint,
    questions,
    answers,
    savedAt: new Date().toISOString(),
  };
}

/** A hit only counts when the fingerprint still matches what the quiz was written against. */
export function isUsable(entry: CachedQuiz | null, fingerprint: string): entry is CachedQuiz {
  return entry !== null && entry.fingerprint === fingerprint;
}
