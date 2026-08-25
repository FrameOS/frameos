"use client";

import { X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { maxVersionMessageLength } from "../lib/store";

export type SceneSaveDialogProps = {
  sceneName: string;
  /** The version this save will publish, for the button and the heading. */
  nextVersion: number | null;
  /** Whether the scene is public — a public save reaches other people. */
  isPublic: boolean;
  /** What the message field starts with: the last AI prompt, when the AI
   * panel is what changed the scenes. */
  defaultMessage?: string | undefined;
  /** The request is in flight (the buttons wait for it). */
  saving: boolean;
  /** The failed save's error, shown here so the retry keeps the message. */
  error?: string | null | undefined;
  onSave: (message: string) => void;
  onClose: () => void;
};

// The bar's "Save as new version": confirms the publish and asks what
// changed, the note that then heads the version in the bar's dropdown and
// in the Versions dialog. The note is optional — Enter on an empty field
// publishes, the way the plain confirm this replaced did. Closed by its ×,
// a click on the backdrop, or Esc. On <body>, like the Install dialog: the
// editor frame's transform would otherwise keep a fixed element inside a
// column.
export function SceneSaveDialog({
  sceneName,
  nextVersion,
  isPublic,
  defaultMessage,
  saving,
  error,
  onSave,
  onClose,
}: SceneSaveDialogProps) {
  const [message, setMessage] = useState(defaultMessage ?? "");
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!saving) {
      onSave(message);
    }
  }

  return createPortal(
    <div aria-label={`Save ${sceneName}`} aria-modal className="dialog" onClick={onClose} role="dialog">
      <div className="dialog__panel" onClick={(event) => event.stopPropagation()}>
        <div className="dialog__head">
          <h2>{nextVersion === null ? "Save a new version" : `Save v${nextVersion}`}</h2>
          <button aria-label="Close" className="dialog__close" onClick={onClose} type="button">
            <X aria-hidden size={18} />
          </button>
        </div>
        <form className="stack" onSubmit={submit}>
          <div className="field">
            <label htmlFor="scene-save-message">What changed? (optional)</label>
            <input
              autoFocus
              className="input"
              disabled={saving}
              id="scene-save-message"
              maxLength={maxVersionMessageLength}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="e.g. Bigger clock, warmer palette"
              type="text"
              value={message}
            />
          </div>
          <p className="copy">
            {isPublic
              ? "Everyone installing or updating this scene gets this version. "
              : "Frames installing or updating this scene get this version. "}
            Your note heads it in the version list.
          </p>
          {error ? <p className="pill pill-warning">{error}</p> : null}
          <div className="button-row">
            <button className="button button-primary" disabled={saving} type="submit">
              {saving ? "Saving…" : "Publish"}
            </button>
            <button className="button button--subtle" disabled={saving} onClick={onClose} type="button">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
