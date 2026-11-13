"use client";

import { LogIn } from "lucide-react";
import { useState } from "react";

// "Continue as …" for the app sign-in (/login/app, src/lib/app-sign-in.ts).
// The press posts the request; the answer is the frameos:// redirect, which
// this page follows itself (a form post could not: form-action).
export function AppSignInForm({
  email,
  request,
}: {
  email: string | undefined;
  request: string;
}) {
  const [state, setState] = useState<"idle" | "submitting" | "error">("idle");
  const authorize = `/api/auth/app/authorize?request=${encodeURIComponent(request)}`;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setState("submitting");
    try {
      const response = await fetch("/api/auth/app/authorize", {
        body: JSON.stringify({ request }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const answer = (await response.json().catch(() => ({}))) as { redirect?: string };
      if (response.ok && answer.redirect) {
        window.location.assign(answer.redirect);
        return;
      }
      // Signed out or the session aged past sudo mode meanwhile: start over.
      window.location.assign(authorize);
    } catch {
      setState("error");
    }
  }

  // Another account: sign this browser out, then the request starts over at
  // the sign-in page.
  async function useAnotherAccount() {
    setState("submitting");
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.assign(authorize);
    }
  }

  return (
    <form className="auth-form" onSubmit={(event) => void submit(event)}>
      {state === "error" ? (
        <p className="notice-error" role="alert">
          Something went wrong. Try again in a moment.
        </p>
      ) : null}
      <div className="actions">
        <button
          className="button button-primary"
          disabled={state === "submitting"}
          type="submit"
        >
          <LogIn aria-hidden="true" size={16} />
          {email ? `Continue as ${email}` : "Continue"}
        </button>
        <button
          className="button"
          disabled={state === "submitting"}
          onClick={() => void useAnotherAccount()}
          type="button"
        >
          Use another account
        </button>
        <a className="button" href={`${authorize}&cancel=1`}>
          Cancel
        </a>
      </div>
    </form>
  );
}
