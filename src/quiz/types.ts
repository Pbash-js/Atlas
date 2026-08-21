import { z } from "zod";
import type { JsonSchema } from "../llm/model";

/**
 * Quiz shapes, in two forms that must agree: a Zod schema for validating what comes back, and a
 * hand-written JSON Schema for `response_format` to constrain what the model emits in the first
 * place. The JSON Schema prevents most malformed replies; the Zod parse catches the rest, since
 * a constrained model can still return something schema-valid but semantically useless (an MCQ
 * whose answer index points past the end of its own options, say).
 */

export const QuestionKind = z.enum(["mcq", "short"]);

/**
 * Every field is present on every question, with sentinels for the ones that do not apply
 * (`options: []`, `answer_index: -1`, `expected: ""`).
 *
 * That is deliberate rather than untidy. `response_format` only guarantees a field appears if it
 * is in `required`, and a field cannot be conditionally required on the value of another — so
 * leaving options optional meant the model simply omitted them for multiple choice, and every
 * MCQ came back unusable. Requiring everything and validating the combination here is what
 * actually holds.
 */
export const Question = z
  .object({
    id: z.string().min(1),
    kind: QuestionKind,
    /** The concept this tests. Stable across quizzes so mastery can accumulate against it. */
    concept: z.string().min(2),
    prompt: z.string().min(10),
    options: z.array(z.string()).default([]),
    answer_index: z.number().int().default(-1),
    expected: z.string().default(""),
  })
  .refine(
    (q) =>
      q.kind !== "mcq" ||
      (q.options.length === 4 && q.answer_index >= 0 && q.answer_index < q.options.length),
    { message: "an mcq needs four options and an answer_index pointing at one of them" },
  )
  .refine((q) => q.kind !== "short" || q.expected.trim().length >= 5, {
    message: "a short-answer question needs an expected answer",
  });

export const Quiz = z.object({
  questions: z.array(Question).min(1).max(10),
});

/** Loose outer parse, so individual questions can be validated (and dropped) one at a time. */
export const QuizEnvelope = z.object({
  questions: z.array(z.unknown()),
});

export type Question = z.infer<typeof Question>;
export type Quiz = z.infer<typeof Quiz>;

/** Mirrors `Quiz` for response_format. Kept adjacent so the two cannot drift apart unnoticed. */
export const QUIZ_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          kind: { type: "string", enum: ["mcq", "short"] },
          concept: { type: "string" },
          prompt: { type: "string" },
          options: {
            type: "array",
            items: { type: "string" },
            description: "Exactly 4 options for kind=mcq; an empty array for kind=short.",
          },
          answer_index: {
            type: "integer",
            description: "Index of the correct option for kind=mcq; -1 for kind=short.",
          },
          expected: {
            type: "string",
            description: "What a correct answer must contain for kind=short; empty for kind=mcq.",
          },
        },
        // All required: response_format cannot make a field conditional on another's value, and
        // anything left out of this list is a field the model will sometimes simply not send.
        required: ["id", "kind", "concept", "prompt", "options", "answer_index", "expected"],
      },
    },
  },
  required: ["questions"],
};

export const Verdict = z.object({
  id: z.string().min(1),
  correct: z.boolean(),
  feedback: z.string().min(1),
});

export const Verdicts = z.object({
  verdicts: z.array(Verdict),
});

export type Verdict = z.infer<typeof Verdict>;

export const VERDICTS_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          correct: { type: "boolean" },
          feedback: { type: "string" },
        },
        required: ["id", "correct", "feedback"],
      },
    },
  },
  required: ["verdicts"],
};

/** One question, the answer given, and how it was judged. */
export interface Result {
  question: Question;
  given: string;
  correct: boolean;
  feedback: string;
}

/** Score at or above this marks the card passed. */
export const PASS_RATIO = 0.8;
