"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// The operator's two hands on a customer's account, from the statement page
// (cloud/docs/accounting-todo.md §5.1 "Superadmin side", §9.3): the AI
// switch and the plan. Both want a reason, both are audited, and both are
// the same mechanisms the account drives for itself — the difference is
// only who is holding them and that the answer to "why" gets written down.

export type PlanOption = {
  code: string;
  name: string;
  priceMicros: string;
  public: boolean;
};

export function CustomerAiSwitch({
  accountId,
  disabledAt,
}: {
  accountId: string;
  disabledAt: string | null;
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const enabled = disabledAt === null;

  async function flip() {
    if (
      enabled &&
      !window.confirm(
        "Switch AI off for this account? Scene chat and the app-code assistant stop working for them immediately, and nothing they do can accrue AI cost until it is switched back on.",
      )
    ) {
      return;
    }
    setBusy(true);
    setMessage(null);
    const response = await fetch(`/api/admin/billing/customers/${accountId}/ai`, {
      body: JSON.stringify({ enabled: !enabled, reason }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    const payload = await response.json().catch(() => ({}));
    setBusy(false);
    if (response.ok) {
      setReason("");
      router.refresh();
    } else {
      setMessage(payload.detail ?? `Failed: ${payload.error ?? response.status}`);
    }
  }

  return (
    <div className="grid">
      <p className="copy">
        {enabled
          ? "AI is on for this account."
          : `AI is off for this account since ${new Date(disabledAt).toLocaleString()}. Nothing they do can accrue AI cost.`}
      </p>
      <div className="inline-actions">
        <input
          aria-label="Reason"
          className="input"
          onChange={(event) => setReason(event.target.value)}
          placeholder="Reason (goes in the audit trail)"
          value={reason}
        />
        <button
          className="button"
          disabled={busy || reason.trim() === ""}
          onClick={() => void flip()}
          type="button"
        >
          {enabled ? "Switch AI off" : "Switch AI back on"}
        </button>
      </div>
      {message ? <p className="copy error">{message}</p> : null}
    </div>
  );
}

export function CustomerPlanForm({
  accountId,
  currentCode,
  plans,
  subscribed,
}: {
  accountId: string;
  currentCode: string;
  plans: PlanOption[];
  subscribed: boolean;
}) {
  const router = useRouter();
  const [code, setCode] = useState(currentCode);
  const [reason, setReason] = useState("");
  const [immediately, setImmediately] = useState(false);
  const [grant, setGrant] = useState(false);
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const target = plans.find((plan) => plan.code === code);
  const toFree = target ? BigInt(target.priceMicros) === 0n : false;
  const giving = grant && !toFree;

  async function apply() {
    if (giving) {
      const ok = window.confirm(
        `Give this account ${target?.name ?? code} for free${until ? ` until the end of ${until}` : " with no end date"}? Nothing is charged or booked.`,
      );
      if (!ok) {
        return;
      }
    } else if (!toFree && code !== currentCode) {
      const ok = window.confirm(
        `Put this account on ${target?.name ?? code}? The first period is charged to their balance now — a receivable Phase 3b has no way to collect yet.`,
      );
      if (!ok) {
        return;
      }
    }
    setBusy(true);
    setMessage(null);
    const response = await fetch(`/api/admin/billing/customers/${accountId}/plan`, {
      body: JSON.stringify(
        giving
          ? { grant: true, plan: code, reason, until: until || null }
          : { immediately: toFree && immediately, plan: code, reason },
      ),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    const payload = await response.json().catch(() => ({}));
    setBusy(false);
    if (response.ok) {
      setReason("");
      setGrant(false);
      setUntil("");
      router.refresh();
    } else {
      setMessage(payload.detail ?? `Failed: ${payload.error ?? response.status}`);
    }
  }

  return (
    <div className="grid">
      <div className="inline-actions">
        <select
          aria-label="Plan"
          className="input"
          onChange={(event) => setCode(event.target.value)}
          value={code}
        >
          {plans.map((plan) => (
            <option key={plan.code} value={plan.code}>
              {plan.name} ({plan.code}
              {plan.public ? "" : ", not public"})
            </option>
          ))}
        </select>
        <input
          aria-label="Reason"
          className="input"
          onChange={(event) => setReason(event.target.value)}
          placeholder="Reason (goes in the audit trail)"
          value={reason}
        />
        <button
          className="button"
          disabled={
            busy ||
            reason.trim() === "" ||
            (!giving && code === currentCode && !(toFree && subscribed))
          }
          onClick={() => void apply()}
          type="button"
        >
          Apply
        </button>
      </div>
      {!toFree ? (
        <label className="copy">
          <input checked={grant} onChange={(event) => setGrant(event.target.checked)} type="checkbox" />{" "}
          Give it for free: nothing is charged or booked, and buying a plan at
          checkout replaces it.
        </label>
      ) : null}
      {giving ? (
        <label className="copy">
          Last day{" "}
          <input
            aria-label="Last day of the free plan"
            className="input"
            min={new Date().toISOString().slice(0, 10)}
            onChange={(event) => setUntil(event.target.value)}
            type="date"
            value={until}
          />{" "}
          (empty: no end date)
        </label>
      ) : null}
      {toFree && subscribed ? (
        <label className="copy">
          <input
            checked={immediately}
            onChange={(event) => setImmediately(event.target.checked)}
            type="checkbox"
          />{" "}
          End it now rather than at the end of the period already charged for
          (nothing is refunded either way — that is a separate entry on the
          Journal page).
        </label>
      ) : null}
      <p className="copy">
        Without the free box, a dearer plan starts now, prorated, and a cheaper
        one takes over at the rollover. Plans not shown on the public ladder are listed here too —
        that is what they are for.
      </p>
      {message ? <p className="copy error">{message}</p> : null}
    </div>
  );
}
