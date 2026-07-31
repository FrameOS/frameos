"use client";

import { Check, Copy } from "lucide-react";
import { useRef, useState } from "react";

// A read-only URL with a one-click copy button; clicking the field selects
// the whole value for manual copying.
export function CopyUrlField({ value }: { value: string }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [copied, setCopied] = useState(false);

  async function copy() {
    inputRef.current?.select();
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard API unavailable (http, permissions): the text is selected,
      // so a manual Cmd/Ctrl+C still works.
      document.execCommand?.("copy");
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="copy-field">
      <input
        aria-label="URL to copy"
        className="copy-field__input"
        onFocus={(event) => event.currentTarget.select()}
        readOnly
        ref={inputRef}
        value={value}
      />
      <button className="button" onClick={() => void copy()} type="button">
        {copied ? <Check aria-hidden size={16} /> : <Copy aria-hidden size={16} />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
