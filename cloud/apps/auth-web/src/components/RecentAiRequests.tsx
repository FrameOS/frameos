"use client";

import { useState } from "react";
import { dollars, surfaceLabel } from "../lib/ai-usage-format";
import { formatDateTime } from "../lib/format";

// The usage page's "Recent requests" table: closed by default and fetched
// from /api/account/ai the first time it is opened, so the page itself does
// not query twenty turn rows most visitors never look at. The route returns
// the same rows the old server-rendered table showed.
interface Turn {
  credited: boolean;
  micros: string;
  model: string;
  occurred_at: string;
  own_key: boolean;
  surface: string | null;
}

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "loaded"; turns: Turn[] };

export function RecentAiRequests() {
  const [state, setState] = useState<State>({ kind: "idle" });

  async function load() {
    setState({ kind: "loading" });
    try {
      const response = await fetch("/api/account/ai", { cache: "no-store" });
      if (!response.ok) {
        setState({ kind: "error" });
        return;
      }
      const body = (await response.json()) as { turns?: Turn[] };
      setState({ kind: "loaded", turns: body.turns ?? [] });
    } catch {
      setState({ kind: "error" });
    }
  }

  return (
    <details
      className="usage-details"
      onToggle={(event) => {
        if (event.currentTarget.open && state.kind === "idle") {
          void load();
        }
      }}
    >
      <summary className="usage-details__summary">Recent requests</summary>
      {state.kind === "loading" || state.kind === "idle" ? (
        <p className="copy">Loading…</p>
      ) : state.kind === "error" ? (
        <p className="copy">Could not load recent requests. Try again in a moment.</p>
      ) : state.turns.length === 0 ? (
        <p className="copy">Nothing yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Feature</th>
              <th>Model</th>
              <th style={{ textAlign: "right" }}>Cost</th>
            </tr>
          </thead>
          <tbody>
            {state.turns.map((turn, index) => (
              <tr key={`${turn.occurred_at}-${index}`}>
                <td>{formatDateTime(new Date(turn.occurred_at))}</td>
                <td>{surfaceLabel(turn.surface)}</td>
                <td className="copy">{turn.model}</td>
                <td style={{ textAlign: "right" }}>
                  {turn.own_key ? "your key" : turn.credited ? "credited" : dollars(BigInt(turn.micros))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}
