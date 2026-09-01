"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Power, Sparkles } from "lucide-react";

// The AI opt-out (cloud/docs/accounting-todo.md §5.1). Explicit, per-account,
// and reachable from the page somebody is already standing on when the "what
// stops this from running up a bill?" thought occurs to them.
//
// It says what stops working before it stops it. A switch whose consequences
// you discover afterwards is a trap, and this one is easy to throw by
// accident from a page full of dollar figures.
export function AiUsageSwitch({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function toggle() {
    if (
      enabled &&
      !window.confirm(
        "Turn AI features off?\n\nScene chat and the app-code assistant will stop working for this account, and nothing you do can incur AI cost. You can turn them back on at any time.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError("");
    const response = await fetch("/api/account/ai", {
      body: JSON.stringify({ enabled: !enabled }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    if (response.ok) {
      router.refresh();
    } else {
      setError("That didn't work. Try again in a moment.");
    }
    setBusy(false);
  }

  return (
    <div>
      <button
        className="button"
        disabled={busy}
        onClick={() => void toggle()}
        type="button"
      >
        {enabled ? <Power aria-hidden size={16} /> : <Sparkles aria-hidden size={16} />}
        {enabled ? "Turn AI features off" : "Turn AI features back on"}
      </button>
      <p className="copy" style={{ marginTop: 8 }}>
        {enabled
          ? "AI is on. Turning it off stops scene chat and the app-code assistant for this account, takes effect immediately, and guarantees no further AI cost."
          : "AI is off for this account. Nothing you do can incur AI cost. Your scenes, frames and backups are unaffected."}
      </p>
      {error ? <p className="copy error">{error}</p> : null}
    </div>
  );
}
