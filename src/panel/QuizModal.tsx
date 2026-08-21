import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { Quiz } from "./Quiz";
import type { Question, Result } from "../quiz/types";

/**
 * The quiz, lifted out of the side panel into a modal.
 *
 * Rendered through a portal to document.body rather than inline, so it is not clipped by the
 * panel's own `overflow-y: auto` and does not inherit its 404px width — multiple-choice options
 * were cramped in the panel, which is most of the reason for moving.
 *
 * While marking is in flight the modal refuses to close: dismissing it mid-request would leave
 * answers submitted, mastery about to change, and nothing on screen to say so.
 */

interface Props {
  title: string;
  chapter: string;
  questions: Question[];
  results: Result[] | null;
  marking: boolean;
  initialAnswers?: Record<string, string>;
  onAnswersChange?: (answers: Record<string, string>) => void;
  onSubmit: (answers: Record<string, string>) => void;
  onClose: () => void;
  onRetake: () => void;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function QuizModal({ title, chapter, marking, onClose, ...rest }: Props) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const headingId = useId();

  // Focus moves into the dialog on open and returns to whatever opened it on close, so keyboard
  // and screen-reader users are not dropped back at the top of the document.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const first = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? dialogRef.current)?.focus();
    return () => opener?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && !marking) {
        ev.preventDefault();
        onClose();
        return;
      }

      // Keep Tab inside the dialog; a modal you can tab out of is a modal in appearance only.
      if (ev.key !== "Tab" || !dialogRef.current) return;
      const items = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;

      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;

      if (ev.shiftKey && active === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && active === last) {
        ev.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [marking, onClose]);

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(ev) => {
        // Only a click that both starts and ends on the backdrop dismisses — dragging a text
        // selection out of the dialog should not throw the quiz away.
        if (ev.target === ev.currentTarget && !marking) onClose();
      }}
    >
      <div
        className="modal modal--quiz"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        ref={dialogRef}
        onMouseDown={(ev) => ev.stopPropagation()}
      >
        <header className="modal__head">
          <div className="modal__titles">
            <div className="modal__kicker">{chapter}</div>
            <h2 className="modal__title" id={headingId}>
              {title}
            </h2>
          </div>
          <button
            className="modal__x"
            aria-label="Close quiz"
            title={marking ? "Wait for marking to finish" : "Close"}
            disabled={marking}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <Quiz marking={marking} onClose={onClose} {...rest} />
      </div>
    </div>,
    document.body,
  );
}
