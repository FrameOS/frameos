import { eq } from "drizzle-orm";
import {
  accountAiUsage,
  readAccountPlan,
  readBillingSettings,
  recentAccountAiTurns,
  utcDayWindow,
  utcMonthWindow,
  type AccountAiUsage,
} from "@frameos-cloud/ledger";
import { accounts, createDb } from "@frameos-cloud/db";
import { AiUsageSwitch } from "../../../src/components/AiUsageSwitch";
import { formatDateTime } from "../../../src/lib/format";
import { readSession } from "../../../src/lib/session";

export const metadata = { title: "AI usage" };

// The page behind the account header's "AI usage" row
// (cloud/docs/accounting-todo.md §5.2). Friendly first, forensic underneath:
// one sentence about this month, where it went in the user's own words, the
// requests behind it, how the price is arrived at, and the off switch.
//
// Every number here comes from the same query the daily cap enforces with and
// the admin statement drills into. Two definitions of "what you have spent"
// that differ by a rounding step is the kind of bug only ever found by a
// confused user.

// Micro-dollars to dollars, rounding UP to the cent: a tenth of a cent of
// usage should read as $0.01, never as nothing at all.
function dollars(micros: bigint): string {
  const cents = (micros + 9_999n) / 10_000n;
  return `$${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, "0")}`;
}

// Surface slugs are for the database. These are for people.
//
// The values are what the routes actually record, which is not the same as
// what they pass to the access gate: the scene chat meters the CLIENT's
// `body.surface` ("editor", "frame", "store", "store-new"), so a map written
// from the gate's argument names would have labelled almost nothing. Checked
// against `select distinct surface from ai_usage_records`.
const surfaceLabels: Record<string, string> = {
  app_chat: "App code assistant",
  editor: "Scene editor chat",
  frame: "Frame chat",
  scene_chat: "Scene chat",
  scene_convert: "Scene converter",
  store: "Store editor chat",
  "store-new": "New scene chat",
  store_classify: "Store classification",
  store_recategorize: "Store recategorisation",
};

// Surfaces the platform pays for on purpose, whoever's key ran them. Listed
// *because* they are free: $0.00 next to a real number is the clearest
// possible statement of what we do and do not charge for.
const freeSurfaces = new Set([
  "scene_convert",
  "store_classify",
  "store_recategorize",
]);

function surfaceLabel(surface: string | null): string {
  if (!surface) {
    return "Other";
  }
  return surfaceLabels[surface] ?? surface.replace(/_/g, " ");
}

export default async function AccountAiPage() {
  const session = await readSession();
  const accountId = session?.accountId;
  if (!accountId) {
    return (
      <section className="card">
        <p className="copy">Sign in to see your AI usage.</p>
      </section>
    );
  }

  const db = createDb();
  const now = new Date();
  const dayWindow = utcDayWindow(now);
  const [[account], thisMonth, lastMonth, today, turns, settings, plan] =
    await Promise.all([
      db
        .select({ aiDisabledAt: accounts.aiDisabledAt })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .limit(1),
      accountAiUsage(db, accountId, utcMonthWindow(now)),
      accountAiUsage(db, accountId, utcMonthWindow(now, -1)),
      accountAiUsage(db, accountId, dayWindow),
      recentAccountAiTurns(db, accountId, { limit: 20 }),
      readBillingSettings(db),
      readAccountPlan(db, accountId),
    ]);

  const enabled = !account?.aiDisabledAt;
  // Billed only when metering is live AND something in the month was actually
  // billable to them. A month spent entirely on the operator's shared key or
  // on absorbed surfaces owes nothing, and saying "this is billed at the end
  // of the month" over that number would be a bill-shaped lie.
  const billed = settings.meteringMode === "live" && thisMonth.billableMicros > 0n;

  return (
    <>
      <section className="card">
        <h2>This month</h2>
        {!enabled ? (
          <p className="copy">
            AI features are switched off for this account, so nothing is being
            used and nothing can be charged.
          </p>
        ) : (
          <p className="copy">
            You&rsquo;ve used <strong>{dollars(thisMonth.chargeableMicros)}</strong>{" "}
            of AI this month across {thisMonth.turns}{" "}
            {thisMonth.turns === 1 ? "request" : "requests"}.{" "}
            {billed
              ? "This is billed at the end of the month."
              : "Nothing is billed — every request above is currently free to you."}
            {lastMonth.turns > 0
              ? ` Last month it was ${dollars(lastMonth.chargeableMicros)}.`
              : null}
          </p>
        )}
        {thisMonth.ownKeyOnly && thisMonth.turns > 0 ? (
          <p className="copy">
            Every request this month ran on your own OpenAI key, so you owe us
            nothing for it — the figure above is what those tokens cost at
            OpenAI&rsquo;s list price, for your own reference.
          </p>
        ) : null}
      </section>

      <section className="card">
        <h2>Where it went</h2>
        {thisMonth.buckets.length === 0 ? (
          <p className="copy">No AI requests yet this month.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Feature</th>
                <th>Requests</th>
                <th style={{ textAlign: "right" }}>This month</th>
              </tr>
            </thead>
            <tbody>
              {collapseBySurface(thisMonth).map((row) => (
                <tr key={row.surface ?? "other"}>
                  <td>
                    {surfaceLabel(row.surface)}
                    {freeSurfaces.has(row.surface ?? "") ? (
                      <span className="pill"> free</span>
                    ) : null}
                  </td>
                  <td>{row.turns}</td>
                  <td style={{ textAlign: "right" }}>
                    {dollars(row.chargeableMicros)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="copy">
          The scene converter and store classification are on us: we asked
          everyone to move off compiled scenes, so the conversion is our
          migration cost rather than a line on your bill.
        </p>
      </section>

      <section className="card">
        <h2>Recent requests</h2>
        {turns.length === 0 ? (
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
              {turns.map((turn, index) => (
                <tr key={`${turn.occurredAt.toISOString()}-${index}`}>
                  <td>{formatDateTime(turn.occurredAt)}</td>
                  <td>{surfaceLabel(turn.surface)}</td>
                  <td className="copy">{turn.model}</td>
                  <td style={{ textAlign: "right" }}>
                    {turn.ownKey ? "your key" : dollars(turn.chargeableMicros)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>How pricing works</h2>
        <p className="copy">
          We pay the model provider for every token a request uses, and add
          our margin on top. That is the whole formula — no per-seat fee, no
          minimum, nothing up front. The exact token counts and unit prices
          behind every request above are on record, which is what makes the
          numbers on this page checkable rather than merely asserted.
        </p>
        <p className="copy">
          You are on the <strong>{plan.plan.name}</strong> plan. A daily limit
          of {dollars(settings.dailyCapMicros)} applies: today you have used{" "}
          {dollars(today.chargeableMicros)}, and it resets at{" "}
          {formatDateTime(dayWindow.until)}. The limit is there so that a
          runaway loop costs you a bounded amount rather than an unbounded one.
        </p>
        {!billed ? (
          <p className="copy">
            Nothing is being charged for AI right now. When that changes you
            will be told before it happens, not after.
          </p>
        ) : null}
      </section>

      <section className="card">
        <h2>Turn AI off</h2>
        <AiUsageSwitch enabled={enabled} />
      </section>
    </>
  );
}

// One row per surface: own-key vs our-key is a real distinction to the books
// and no distinction at all to somebody reading their own usage, so it is
// summed away here rather than shown as two "Scene chat" rows that do not
// visibly add up to the number at the top of the page.
function collapseBySurface(usage: AccountAiUsage) {
  const bySurface = new Map<
    string | null,
    { chargeableMicros: bigint; surface: string | null; turns: number }
  >();
  for (const bucket of usage.buckets) {
    const existing = bySurface.get(bucket.surface);
    if (existing) {
      existing.chargeableMicros += bucket.chargeableMicros;
      existing.turns += bucket.turns;
    } else {
      bySurface.set(bucket.surface, {
        chargeableMicros: bucket.chargeableMicros,
        surface: bucket.surface,
        turns: bucket.turns,
      });
    }
  }
  return [...bySurface.values()].sort((a, b) =>
    a.chargeableMicros === b.chargeableMicros
      ? b.turns - a.turns
      : b.chargeableMicros > a.chargeableMicros
        ? 1
        : -1,
  );
}
