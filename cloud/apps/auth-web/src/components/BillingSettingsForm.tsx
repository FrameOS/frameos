"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export type BillingSettingsValues = {
  aiMarginPercent: string;
  meteringMode: "live" | "shadow";
  overdraftMicros: string;
};

// The three knobs, and the one warning worth putting in front of a human:
// flipping metering to live is the moment measurement becomes money.
// Everything it changes is forward-looking — the margin is snapshotted into
// each record it prices and the mode is stamped on the record itself — so
// the shadow period stays shadow forever, whatever this is set to later.
export function BillingSettingsForm({
  values,
}: {
  values: BillingSettingsValues;
}) {
  const router = useRouter();
  const [margin, setMargin] = useState(values.aiMarginPercent);
  const [overdraft, setOverdraft] = useState(values.overdraftMicros);
  const [mode, setMode] = useState<"live" | "shadow">(values.meteringMode);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (
      mode === "live" &&
      values.meteringMode !== "live" &&
      !window.confirm(
        "Switch metering to live? Every turn from now on posts real entries to the ledger. Records already written in shadow mode stay unposted.",
      )
    ) {
      return;
    }
    setBusy(true);
    setMessage(null);
    const response = await fetch("/api/admin/billing/settings", {
      body: JSON.stringify({
        settings: {
          ai_margin_percent: margin,
          ai_metering_mode: mode,
          payg_overdraft_micros: overdraft,
        },
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const payload = await response.json().catch(() => ({}));
    setBusy(false);
    if (response.ok) {
      setMessage("Saved.");
      router.refresh();
    } else {
      setMessage(payload.detail ?? `Failed: ${payload.error ?? response.status}`);
    }
  }

  return (
    <form className="grid" onSubmit={(event) => void save(event)}>
      <div className="field">
        <label htmlFor="billing-margin">Margin over provider cost (%)</label>
        <input
          className="input"
          id="billing-margin"
          inputMode="decimal"
          onChange={(event) => setMargin(event.target.value)}
          value={margin}
        />
        <p className="copy">
          What a metered turn is priced at above what it cost us. Snapshotted
          into every record it prices, so changing it never re-prices the past.
        </p>
      </div>

      <div className="field">
        <label htmlFor="billing-overdraft">Overdraft allowance (micro-dollars)</label>
        <input
          className="input"
          id="billing-overdraft"
          inputMode="numeric"
          onChange={(event) => setOverdraft(event.target.value)}
          value={overdraft}
        />
        <p className="copy">
          How far a customer&apos;s credit may go below zero before the next
          turn is refused. A turn&apos;s cost is unknown until it ends, so this
          is how much of that overshoot we accept — 1,000,000 is one dollar.
        </p>
      </div>

      <div className="field">
        <label htmlFor="billing-mode">Metering mode</label>
        <select
          className="input"
          id="billing-mode"
          onChange={(event) => setMode(event.target.value === "live" ? "live" : "shadow")}
          value={mode}
        >
          <option value="shadow">shadow — measure and price, post nothing</option>
          <option value="live">live — post entries to the ledger</option>
        </select>
        <p className="copy">
          Shadow is the measurement phase: every turn is priced and recorded,
          and no entry reaches the journal. Records keep the mode they were
          written under, so flipping this cannot retroactively bill the shadow
          period.
        </p>
      </div>

      <div className="inline-actions">
        <button className="button button-primary" disabled={busy} type="submit">
          {busy ? "Saving…" : "Save settings"}
        </button>
        {message ? <span className="pill">{message}</span> : null}
      </div>
    </form>
  );
}
