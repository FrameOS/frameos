"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { formatMicrosUsd } from "../lib/format";

type Leg = { accountCode: string; amount: string; direction: "credit" | "debit" };

const emptyLeg: Leg = { accountCode: "", amount: "", direction: "debit" };

// Dollars as typed -> micro-dollars. Rejects rather than rounds: an amount
// with more precision than the ledger can hold is a typo, and silently
// truncating one into the books is how a cent goes missing.
function toMicros(amount: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(amount.trim());
  if (!match) {
    return null;
  }
  const fraction = (match[2] ?? "").padEnd(6, "0");
  return BigInt(match[1]!) * 1_000_000n + BigInt(fraction);
}

// Posting to the journal by hand: the two forms an admin needs that no
// automated recipe covers.
//
// The manual journal is the escape hatch — an opening balance, a provider
// invoice settled by hand, a correction nobody wrote a rule for. It still
// goes through the posting kernel, so it is still an event, still idempotent
// and still reversible; what it is not is a route that writes postings
// directly, because there is no such route.
//
// The reclassification is the narrower thing: an amount sitting in the wrong
// account. It is a real entry with real consequences, unlike re-pointing an
// account at another reporting group (Chart of accounts), which changes how
// the books are presented and not what they say.
export function JournalPostForm({ accountCodes }: { accountCodes: string[] }) {
  const router = useRouter();
  const [mode, setMode] = useState<"manual" | "reclassify">("manual");
  const [reason, setReason] = useState("");
  const [legs, setLegs] = useState<Leg[]>([
    { ...emptyLeg },
    { ...emptyLeg, direction: "credit" },
  ]);
  const [reclassify, setReclassify] = useState({
    amount: "",
    creditAccountCode: "",
    debitAccountCode: "",
    entryId: "",
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Shown live, because an unbalanced entry is the single most common thing
  // to get wrong here and the kernel's refusal is a worse place to find out.
  const drift = useMemo(() => {
    let total = 0n;
    for (const leg of legs) {
      const micros = toMicros(leg.amount);
      if (micros === null) {
        return null;
      }
      total += leg.direction === "debit" ? micros : -micros;
    }
    return total;
  }, [legs]);

  function updateLeg(index: number, patch: Partial<Leg>) {
    setLegs((current) =>
      current.map((leg, at) => (at === index ? { ...leg, ...patch } : leg)),
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);

    const body =
      mode === "manual"
        ? {
            action: "manual_journal",
            legs: legs.map((leg) => ({
              accountCode: leg.accountCode.trim(),
              amountMicros: toMicros(leg.amount)?.toString() ?? "0",
              direction: leg.direction,
            })),
            reason: reason.trim(),
          }
        : {
            action: "reclassify",
            amountMicros: toMicros(reclassify.amount)?.toString() ?? "0",
            creditAccountCode: reclassify.creditAccountCode.trim(),
            debitAccountCode: reclassify.debitAccountCode.trim(),
            reason: reason.trim(),
            ...(reclassify.entryId.trim()
              ? { reclassifiesEntryId: reclassify.entryId.trim() }
              : {}),
          };

    const response = await fetch("/api/admin/billing/journal", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const payload = await response.json().catch(() => ({}));
    setBusy(false);
    if (response.ok) {
      setMessage(`Posted ${payload.entries?.length ?? 0} entr(y/ies).`);
      setReason("");
      setLegs([{ ...emptyLeg }, { ...emptyLeg, direction: "credit" }]);
      setReclassify({ amount: "", creditAccountCode: "", debitAccountCode: "", entryId: "" });
      router.refresh();
    } else {
      setMessage(payload.detail ?? `Failed: ${payload.error ?? response.status}`);
    }
  }

  return (
    <form className="grid" onSubmit={(event) => void submit(event)}>
      <datalist id="ledger-account-codes">
        {accountCodes.map((code) => (
          <option key={code} value={code} />
        ))}
      </datalist>

      <div className="field">
        <label htmlFor="journal-mode">What are you posting?</label>
        <select
          className="input"
          id="journal-mode"
          onChange={(event) =>
            setMode(event.target.value === "reclassify" ? "reclassify" : "manual")
          }
          value={mode}
        >
          <option value="manual">Manual journal — state the legs</option>
          <option value="reclassify">
            Reclassification — move an amount between two accounts
          </option>
        </select>
      </div>

      <div className="field">
        <label htmlFor="journal-reason">Reason</label>
        <input
          className="input"
          id="journal-reason"
          onChange={(event) => setReason(event.target.value)}
          placeholder="Settled the August OpenAI invoice"
          value={reason}
        />
        <p className="copy">
          Becomes the entry&apos;s description and its audit record. Required.
        </p>
      </div>

      {mode === "manual" ? (
        <div className="field">
          <label>Legs</label>
          {legs.map((leg, index) => (
            <div className="inline-actions" key={index}>
              <select
                aria-label={`Leg ${index + 1} direction`}
                className="input"
                onChange={(event) =>
                  updateLeg(index, {
                    direction: event.target.value === "credit" ? "credit" : "debit",
                  })
                }
                value={leg.direction}
              >
                <option value="debit">Dr</option>
                <option value="credit">Cr</option>
              </select>
              <input
                aria-label={`Leg ${index + 1} account`}
                className="input"
                list="ledger-account-codes"
                onChange={(event) => updateLeg(index, { accountCode: event.target.value })}
                placeholder="expense:cogs:openai"
                value={leg.accountCode}
              />
              <input
                aria-label={`Leg ${index + 1} amount`}
                className="input"
                inputMode="decimal"
                onChange={(event) => updateLeg(index, { amount: event.target.value })}
                placeholder="10.00"
                value={leg.amount}
              />
              {legs.length > 2 ? (
                <button
                  className="button button--small button--subtle"
                  onClick={() => setLegs(legs.filter((_, at) => at !== index))}
                  type="button"
                >
                  Remove
                </button>
              ) : null}
            </div>
          ))}
          <div className="inline-actions">
            <button
              className="button button--small button--subtle"
              onClick={() => setLegs([...legs, { ...emptyLeg }])}
              type="button"
            >
              Add leg
            </button>
            {drift === null ? (
              <span className="risk-badge">an amount is not a number</span>
            ) : drift === 0n ? (
              <span className="pill pill-ok">balanced</span>
            ) : (
              <span className="risk-badge">
                out of balance by {formatMicrosUsd(drift)}
              </span>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="field">
            <label htmlFor="reclass-debit">Debit (the account gaining a debit)</label>
            <input
              className="input"
              id="reclass-debit"
              list="ledger-account-codes"
              onChange={(event) =>
                setReclassify({ ...reclassify, debitAccountCode: event.target.value })
              }
              placeholder="revenue:ai_usage"
              value={reclassify.debitAccountCode}
            />
          </div>
          <div className="field">
            <label htmlFor="reclass-credit">Credit (the account gaining a credit)</label>
            <input
              className="input"
              id="reclass-credit"
              list="ledger-account-codes"
              onChange={(event) =>
                setReclassify({ ...reclassify, creditAccountCode: event.target.value })
              }
              placeholder="revenue:subscriptions"
              value={reclassify.creditAccountCode}
            />
          </div>
          <div className="field">
            <label htmlFor="reclass-amount">Amount (dollars)</label>
            <input
              className="input"
              id="reclass-amount"
              inputMode="decimal"
              onChange={(event) => setReclassify({ ...reclassify, amount: event.target.value })}
              placeholder="5.00"
              value={reclassify.amount}
            />
          </div>
          <div className="field">
            <label htmlFor="reclass-entry">Entry it corrects (optional)</label>
            <input
              className="input"
              id="reclass-entry"
              onChange={(event) => setReclassify({ ...reclassify, entryId: event.target.value })}
              placeholder="ledger entry uuid"
              value={reclassify.entryId}
            />
            <p className="copy">
              Recorded as a link, not a reversal: the original entry stands and
              this moves one amount out of it.
            </p>
          </div>
        </>
      )}

      <div className="inline-actions">
        <button className="button button-primary" disabled={busy} type="submit">
          {busy ? "Posting…" : "Post to the journal"}
        </button>
        {message ? <span className="pill">{message}</span> : null}
      </div>
    </form>
  );
}
