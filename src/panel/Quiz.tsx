import { useState } from "react";
import type { Question, Result } from "../quiz/types";
import { PASS_RATIO } from "../quiz/types";
import { C } from "../lib/format";

interface Props {
  questions: Question[];
  results: Result[] | null;
  marking: boolean;
  /** Answers restored from the cache, so a set-aside quiz resumes where it was left. */
  initialAnswers?: Record<string, string>;
  onAnswersChange?: (answers: Record<string, string>) => void;
  onSubmit: (answers: Record<string, string>) => void;
  onClose: () => void;
  onRetake: () => void;
}

export function Quiz({
  questions,
  results,
  marking,
  initialAnswers,
  onAnswersChange,
  onSubmit,
  onClose,
  onRetake,
}: Props) {
  const [answers, setAnswers] = useState<Record<string, string>>(initialAnswers ?? {});
  const answered = questions.filter((q) => (answers[q.id] ?? "").trim() !== "").length;

  /** Update locally and tell the host, so the cache keeps pace with what has been typed. */
  const record = (id: string, value: string) => {
    setAnswers((prev) => {
      const next = { ...prev, [id]: value };
      onAnswersChange?.(next);
      return next;
    });
  };

  if (results) {
    const score = results.filter((r) => r.correct).length;
    const ratio = results.length ? score / results.length : 0;
    const passed = ratio >= PASS_RATIO;

    return (
      <div className="quiz">
        <div className="quiz__body">
          <div
            className="quiz__verdict"
            style={{
              borderColor: passed ? C("--at-passed") : C("--at-progress"),
              color: passed ? C("--at-passed") : C("--at-progress"),
            }}
          >
            <div className="quiz__verdict-h">
              {passed ? "Passed" : "Not yet"} · {score} of {results.length}
            </div>
            <div className="quiz__verdict-b">
              {passed
                ? "That clears the bar for this card. What you missed is still recorded, and the next quiz will come back to it."
                : "Atlas has noted which ideas slipped. The next quiz will weight them more heavily and keep the rest in rotation."}
            </div>
          </div>

          <ul className="quiz__results">
            {results.map((r) => (
              <li
                key={r.question.id}
                className={r.correct ? "quiz__result is-ok" : "quiz__result is-bad"}
              >
                <div className="quiz__result-top">
                  <span className="quiz__mark">{r.correct ? "◈" : "✕"}</span>
                  <span className="quiz__concept">{r.question.concept}</span>
                </div>
                <p className="quiz__q">{r.question.prompt}</p>
                <p className="quiz__fb">{r.feedback}</p>
              </li>
            ))}
          </ul>
        </div>

        <div className="quiz__foot">
          <button className="btn" onClick={onRetake}>
            Another quiz
          </button>
          <button className="btn btn--quiet" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="quiz">
      <div className="quiz__body">
        <ol className="quiz__list">
          {questions.map((q, i) => (
            <li key={q.id} className="quiz__item">
              <div className="quiz__item-top">
                <span className="quiz__num tnum">{i + 1}</span>
                <span className="quiz__concept">{q.concept}</span>
              </div>
              <p className="quiz__q">{q.prompt}</p>

              {q.kind === "mcq" && q.options.length > 0 ? (
                <div className="quiz__options">
                  {q.options.map((opt, oi) => (
                    <label
                      key={oi}
                      className={answers[q.id] === String(oi) ? "quiz__opt is-picked" : "quiz__opt"}
                    >
                      <input
                        type="radio"
                        name={q.id}
                        checked={answers[q.id] === String(oi)}
                        onChange={() => record(q.id, String(oi))}
                      />
                      <span>{opt}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <textarea
                  className="ta"
                  rows={3}
                  placeholder="A sentence or two."
                  value={answers[q.id] ?? ""}
                  onChange={(e) => record(q.id, e.target.value)}
                />
              )}
            </li>
          ))}
        </ol>
      </div>

      <div className="quiz__foot">
        <button
          className="btn"
          disabled={marking || answered === 0}
          onClick={() => onSubmit(answers)}
        >
          {marking ? "Marking…" : "Submit"}
        </button>
        <button className="btn btn--quiet" disabled={marking} onClick={onClose}>
          Set aside
        </button>
        <span className="check__hint tnum">
          {answered} of {questions.length} answered
        </span>
      </div>
    </div>
  );
}
