import { eq } from "drizzle-orm";
import {
  absorbedSurfaces,
  accountAiUsage,
  accountBalanceMicros,
  accountMarginBasisPoints,
  customerReceivableCode,
  customerStatement,
  readAccountPlan,
  readBillingSettings,
  recentAccountAiTurns,
  utcDayWindow,
  utcMonthWindow,
  type AccountAiUsage,
} from "@frameos-cloud/ledger";
import { accounts, createDb } from "@frameos-cloud/db";
import { AiUsageSwitch } from "../../../src/components/AiUsageSwitch";
import { resolveAiCredentials } from "../../../src/lib/ai/api-key";
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
// usage should read as $0.01, never as nothing at all. Negative amounts (a
// credit in the customer's favour) keep their sign.
function dollars(micros: bigint): string {
  const negative = micros < 0n;
  const absolute = negative ? -micros : micros;
  const cents = (absolute + 9_999n) / 10_000n;
  return `${negative ? "-" : ""}$${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, "0")}`;
}

// Surface slugs are for the database. These are for people. The surface is
// the gate's own name for the route (never the client's — §9.2 item 1), so
// this map is the gate's argument names, one label each.
const surfaceLabels: Record<string, string> = {
  app_chat: "App code assistant",
  scene_chat: "Scene chat",
  scene_convert: "Scene converter",
  store_classify: "Store classification",
  store_recategorize: "Store recategorisation",
};

// Surfaces the platform pays for on purpose, whoever's key ran them. Listed
// *because* they are free: $0.00 next to a real number is the clearest
// possible statement of what we do and do not charge for. Read from the
// ledger's one list, so the page cannot call something free that the meter
// charges for.
const freeSurfaces = new Set(absorbedSurfaces);

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
  const receivable = customerReceivableCode(accountId);
  const [[account], thisMonth, lastMonth, today, turns, settings, plan, owed, statement, credentials] =
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
      accountBalanceMicros(db, receivable),
      customerStatement(db, receivable, { limit: 1000 }),
      // Which key the next turn runs on decides which daily limit applies,
      // and whose money it guards (§5.3).
      resolveAiCredentials(db, accountId),
    ]);
  // ONE margin definition, the same one metering prices with (plans.ts).
  const marginBasisPoints = await accountMarginBasisPoints(db, accountId, settings);
  const sharedKey = credentials?.source === "shared";
  const dailyCapMicros = sharedKey ? settings.sharedKeyDailyCapMicros : settings.dailyCapMicros;

  const enabled = !account?.aiDisabledAt;
  // The statement lines that are not metered turns: subscription charges,
  // credits, refunds, write-offs. The turns are the table further down; these
  // are the rest of what the balance is made of.
  const otherLines = statement.lines
    .filter((line) => line.entryType !== "ai_usage_charge")
    .slice(-10)
    .reverse();
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

      {settings.meteringMode === "live" || owed !== 0n || otherLines.length > 0 ? (
        <section className="card">
          <h2>Your balance</h2>
          <p className="copy">
            {owed > 0n
              ? `You currently owe ${dollars(owed)}. That is what the month-end invoice collects: metered usage, any plan fee, less any credit.`
              : owed < 0n
                ? `You have a credit of ${dollars(-owed)} in your favour, which nets against future usage.`
                : "Nothing is owed right now."}
          </p>
          {otherLines.length > 0 ? (
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>What</th>
                  <th style={{ textAlign: "right" }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {otherLines.map((line) => (
                  <tr key={line.entryId}>
                    <td>{formatDateTime(line.occurredAt)}</td>
                    <td>{line.description}</td>
                    <td style={{ textAlign: "right" }}>
                      {line.direction === "debit" ? "" : "-"}
                      {dollars(line.amountMicros)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </section>
      ) : null}

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
                    {turn.ownKey
                      ? "your key"
                      : turn.credited
                        ? "credited"
                        : dollars(turn.chargeableMicros)}
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
          our margin on top — {(marginBasisPoints / 100).toFixed(marginBasisPoints % 100 === 0 ? 0 : 2)}% on
          your plan. That is the whole formula — no per-seat fee, no minimum,
          nothing up front. The exact token counts and unit prices behind
          every request above are on record, which is what makes the numbers
          on this page checkable rather than merely asserted.
        </p>
        <p className="copy">
          You are on the <strong>{plan.plan.name}</strong> plan
          {plan.nextPlanCode ? ` (moving to ${plan.nextPlanCode} at the next renewal)` : ""}
          {plan.cancelAt ? ` (ends ${formatDateTime(plan.cancelAt)})` : ""}.
          {plan.plan.priceMicros > 0n
            ? " The plan fee is billed at the start of each period, in advance; AI usage is billed at the end of the month, for what was actually used."
            : ""}{" "}
          {sharedKey ? (
            <>
              Your requests run on the operator&rsquo;s shared key, which comes
              with a free daily allowance of {dollars(dailyCapMicros)}: today
              you have used {dollars(today.chargeableMicros)} of it, and it
              resets at {formatDateTime(dayWindow.until)}. That allowance is
              the operator&rsquo;s budget, not a bill — nothing on it is ever
              charged to you. Add your own OpenAI key under Settings to use AI
              without it.
            </>
          ) : (
            <>
              A daily limit of {dollars(dailyCapMicros)} applies: today you
              have used {dollars(today.chargeableMicros)}, and it resets at{" "}
              {formatDateTime(dayWindow.until)}. The limit is there so that a
              runaway loop costs you a bounded amount rather than an unbounded
              one.
            </>
          )}
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
