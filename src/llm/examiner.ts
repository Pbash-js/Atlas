import type { RecoveryNode, UnitNode } from "../schema/atlas";
import { extractJson, type ReasoningModel } from "./model";
import {
  Question,
  QuizEnvelope,
  QUIZ_SCHEMA,
  Verdicts,
  VERDICTS_SCHEMA,
  type Result,
} from "../quiz/types";
import type { Focus, NodeMastery } from "../quiz/mastery";

/**
 * The Examiner: write the quiz, then mark it.
 *
 * Marking is split deliberately. Multiple choice is graded HERE, in code, by comparing indices —
 * it is free, instant, and cannot be talked out of the right answer. Only short answers go to the
 * model, in a single batched call. That keeps the expensive, fallible half as small as possible
 * and means a quiz of pure MCQs needs no second network round trip at all.
 */

const GENERATE_SYSTEM = `You write short quizzes that test whether someone can actually DO one step of a learning plan.

WHAT MAKES A GOOD QUESTION HERE:
- It tests application, not recall of wording. Prefer "given this situation, what happens" over "what is the definition of".
- Multiple choice ("mcq") needs exactly 4 options, with ONE correct. The wrong options must be plausible mistakes a real learner makes — never filler, never obviously absurd.
- Short answer ("short") asks for one or two sentences, and "expected" states what a correct answer must contain so it can be marked fairly.
- Mix the two. Roughly two thirds mcq, one third short.

CONCEPTS — this matters most:
Every question carries a "concept": the specific idea it tests. These are how progress is tracked across quizzes, so they MUST be reused verbatim when they already exist. Only invent a new concept label when the question genuinely tests something not covered by any existing label. Keep new labels short (2-5 words) and specific.

"id" is a short unique string per question, like "q1".`;

const ASSESS_SYSTEM = `You mark short free-text answers to a quiz. For each one decide correct: true or false, and give one sentence of feedback.

Be fair, not lenient and not pedantic:
- Mark correct if the answer contains the substance of what was expected, even if the wording differs, the spelling is poor, or it is briefer than the expected answer.
- Mark incorrect if it misses the key idea, states something false, or is so vague it could apply to anything.
- Feedback speaks to the learner, briefly. If they got it wrong, say what was missing — do not just restate the expected answer.`;

export interface QuizRequest {
  node: UnitNode | RecoveryNode;
  goalStatement: string;
  mastery: NodeMastery;
  focus: Focus;
  count: number;
}

function describeFocus(focus: Focus, mastery: NodeMastery): string {
  if (focus.drill.length === 0 && focus.rotate.length === 0) {
    return "This is the first quiz on this step. Cover its main ideas broadly, and set the concept labels carefully — later quizzes will reuse them.";
  }

  const strengthOf = (name: string) =>
    mastery.concepts.find((c) => c.concept === name)?.strength ?? 0.5;

  const lines: string[] = [];
  if (focus.drill.length) {
    lines.push(
      `WEAK — spend most of the quiz here:\n${focus.drill
        .map((c) => `- ${c} (grasp ${(strengthOf(c) * 100).toFixed(0)}%)`)
        .join("\n")}`,
    );
  }
  if (focus.rotate.length) {
    lines.push(
      `SOLID — include one or two to confirm it has stuck:\n${focus.rotate
        .map((c) => `- ${c} (grasp ${(strengthOf(c) * 100).toFixed(0)}%)`)
        .join("\n")}`,
    );
  }
  lines.push(
    "Reuse these concept labels EXACTLY as written. Ask the weak ones from a different angle than a plain repeat.",
  );
  return lines.join("\n\n");
}

export async function generateQuiz(
  model: ReasoningModel,
  req: QuizRequest,
  signal?: AbortSignal,
): Promise<Question[]> {
  const { node, goalStatement, mastery, focus, count } = req;
  const known = mastery.concepts.map((c) => c.concept);

  const input = [
    `OVERALL GOAL: ${goalStatement}`,
    `THIS STEP: ${node.title}`,
    `WHY IT MATTERS: ${node.why}`,
    node.exit_check
      ? `WHAT MASTERY OF THIS STEP MEANS:\n${node.exit_check.rubric.map((r) => `- ${r}`).join("\n")}`
      : "",
    known.length ? `EXISTING CONCEPT LABELS (reuse verbatim where they fit):\n${known.map((c) => `- ${c}`).join("\n")}` : "",
    describeFocus(focus, mastery),
    `Write exactly ${count} questions.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const raw = await model.generate({ system: GENERATE_SYSTEM, input, signal, schema: QUIZ_SCHEMA });
  const envelope = QuizEnvelope.parse(extractJson(raw));

  // Parse question by question. A schema-constrained model still gets an individual question
  // wrong occasionally, and losing one of five is a far better outcome than losing the quiz.
  const usable: Question[] = [];
  for (const candidate of envelope.questions) {
    const parsed = Question.safeParse(candidate);
    if (parsed.success) usable.push(parsed.data);
  }

  if (usable.length === 0) {
    throw new Error("The quiz came back unusable — none of the questions were well formed.");
  }

  return usable.slice(0, count);
}

/** Deterministic half of marking: MCQ by index comparison. No model, no ambiguity. */
export function gradeObjective(question: Question, given: string): Result | null {
  if (question.kind !== "mcq" || !question.options) return null;

  const chosen = Number.parseInt(given, 10);
  const correct = Number.isInteger(chosen) && chosen === question.answer_index;
  const answer = question.options[question.answer_index ?? 0] ?? "";

  return {
    question,
    given,
    correct,
    feedback: correct ? "Correct." : `The answer is: ${answer}`,
  };
}

export async function assess(
  model: ReasoningModel,
  questions: Question[],
  answers: Record<string, string>,
  signal?: AbortSignal,
): Promise<Result[]> {
  const results: Result[] = [];
  const needsModel: Question[] = [];

  for (const q of questions) {
    const given = answers[q.id] ?? "";
    const objective = gradeObjective(q, given);
    if (objective) {
      results.push(objective);
      continue;
    }
    // An unanswered short question is wrong without spending a call to find that out.
    if (!given.trim()) {
      results.push({ question: q, given, correct: false, feedback: "Left blank." });
      continue;
    }
    needsModel.push(q);
  }

  if (needsModel.length > 0) {
    const input = needsModel
      .map((q) =>
        [
          `id: ${q.id}`,
          `question: ${q.prompt}`,
          `expected: ${q.expected}`,
          `their answer: ${answers[q.id]}`,
        ].join("\n"),
      )
      .join("\n\n---\n\n");

    const raw = await model.generate({
      system: ASSESS_SYSTEM,
      input,
      signal,
      schema: VERDICTS_SCHEMA,
    });
    const { verdicts } = Verdicts.parse(extractJson(raw));
    const byId = new Map(verdicts.map((v) => [v.id, v]));

    for (const q of needsModel) {
      const v = byId.get(q.id);
      results.push({
        question: q,
        given: answers[q.id] ?? "",
        // A verdict the grader failed to return is not silently a pass.
        correct: v?.correct ?? false,
        feedback: v?.feedback ?? "This one could not be marked.",
      });
    }
  }

  // Restore the order the learner saw, so feedback lines up with the quiz.
  const order = new Map(questions.map((q, i) => [q.id, i]));
  return results.sort((a, b) => (order.get(a.question.id) ?? 0) - (order.get(b.question.id) ?? 0));
}
