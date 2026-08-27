"use client";

import { Sparkles } from "lucide-react";
import { useCallback, useRef, type KeyboardEvent } from "react";

/** How tall the prompt is allowed to grow before it scrolls instead. */
const MAX_ROWS = 10;

// A quiet prompt box for the store front and "My scenes": describe a scene,
// land in the new-scene editor with the AI already working on it
// (/my-scenes/new?prompt=…; that page asks for sign-in first if needed).
// Still a plain GET form — the only JavaScript here is the growing textarea.
//
// A scene description is often a paragraph (what to show, where, in which
// colours), and a one-line input hid all but the tail of it while typing.
// The textarea starts one line tall and follows the text down to MAX_ROWS.
export function CreateSceneWithAiBox({
  action,
  autoFocus = false,
  compact = false,
}: {
  action: string;
  /** Focus the prompt on mount (when opened from an action card). */
  autoFocus?: boolean;
  /** Just the prompt row — the card that opened it already says what it is. */
  compact?: boolean;
}) {
  const formRef = useRef<HTMLFormElement | null>(null);

  // Measure against the real content: collapse to nothing first, then take
  // scrollHeight. Capped in whole lines so the growth reads as line breaks
  // rather than an arbitrary jump.
  const resize = useCallback((textarea: HTMLTextAreaElement | null) => {
    if (!textarea) {
      return;
    }
    const styles = window.getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(styles.lineHeight) || 20;
    const chrome =
      Number.parseFloat(styles.paddingTop) +
      Number.parseFloat(styles.paddingBottom) +
      Number.parseFloat(styles.borderTopWidth) +
      Number.parseFloat(styles.borderBottomWidth);
    textarea.style.height = "0px";
    const wanted = textarea.scrollHeight - chrome;
    const rows = Math.min(MAX_ROWS, Math.max(1, Math.round(wanted / lineHeight)));
    textarea.style.height = `${rows * lineHeight + chrome}px`;
    textarea.style.overflowY = rows < MAX_ROWS ? "hidden" : "auto";
  }, []);

  // Enter sends the prompt (it is a form field, not a document); Shift+Enter
  // is the newline. `isComposing` keeps an IME's Enter out of it.
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    formRef.current?.requestSubmit();
  }

  return (
    <form
      action={action}
      className={compact ? "card ai-create-box ai-create-box--compact" : "card ai-create-box"}
      method="get"
      ref={formRef}
    >
      {compact ? null : (
        <div className="ai-create-box__text">
          <h3>
            <Sparkles aria-hidden size={16} />
            Create a scene with AI
          </h3>
          <p>
            Describe what you want on the display. The assistant builds it in the
            editor; you tweak it and save it to your scenes.
          </p>
        </div>
      )}
      <div className="ai-create-box__row">
        <textarea
          aria-label="Describe the scene you want"
          autoComplete="off"
          autoFocus={autoFocus}
          className="input ai-create-box__prompt"
          maxLength={2000}
          name="prompt"
          onInput={(event) => resize(event.currentTarget)}
          onKeyDown={onKeyDown}
          placeholder="A clock with today's weather for Berlin, big text on dark green…"
          // Sized on mount too: the browser may restore a typed value on a
          // back-navigation, and ?prompt= round-trips through this field.
          ref={resize}
          required
          rows={1}
        />
        <button className="button" type="submit">
          Create
        </button>
      </div>
    </form>
  );
}
