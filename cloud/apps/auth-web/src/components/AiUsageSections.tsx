import { eq } from "drizzle-orm";
import {
  absorbedSurfaces,
  accountAiUsage,
  accountBalanceMicros,
  customerReceivableCode,
  customerStatement,
  readAccountPlan,
  readBillingSettings,
  utcDayWindow,
  utcMonthWindow,
  type AccountAiUsage,
} from "@frameos-cloud/ledger";
import { accounts, createDb } from "@frameos-cloud/db";
import { AiUsageSwitch } from "./AiUsageSwitch";
import { RecentAiRequests } from "./RecentAiRequests";
import { resolveAiCredentials } from "../lib/ai/api-key";
import { dollars, surfaceLabel } from "../lib/ai-usage-format";
import { formatDateTime } from "../lib/format";

// The AI half of the usage page (app/account/usage; cloud/docs/accounting-todo.md
// §5.2): one card with this month's figure, where it went, the recent
// requests (loaded when opened, RecentAiRequests) and the off switch, then a
// card on how pricing works.
//
// Every number here comes from the same query the daily cap enforces with and
// the admin statement drills into. Two definitions of "what you have spent"
// that differ by a rounding step is the kind of bug only ever found by a
// confused user.

// Surfaces the platform pays for on purpose, whoever's key ran them. Listed
// *because* they are free: $0.00 next to a real number is the clearest
// possible statement of what we do and do not charge for. Read from the
// ledger's one list, so the page cannot call something free that the meter
// charges for.
const freeSurfaces = new Set(absorbedSurfaces);

export async function AiUsageSections({ accountId }: { accountId: string }) {
  const db = createDb();
  const now = new Date();
  const dayWindow = utcDayWindow(now);
  const receivable = customerReceivableCode(accountId);
  const [[account], thisMonth, lastMonth, today, settings, plan, owed, statement, credentials] =
    await Promise.all([
      db
        .select({ aiDisabledAt: accounts.aiDisabledAt })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .limit(1),
      accountAiUsage(db, accountId, utcMonthWindow(now)),
      accountAiUsage(db, accountId, utcMonthWindow(now, -1)),
      accountAiUsage(db, accountId, dayWindow),
      readBillingSettings(db),
      readAccountPlan(db, accountId),
      accountBalanceMicros(db, receivable),
      customerStatement(db, receivable, { limit: 1000 }),
      // Which key the next turn runs on decides which daily limit applies,
      // and whose money it guards (§5.3).
      resolveAiCredentials(db, accountId),
    ]);
  const sharedKey = credentials?.source === "shared";
  const dailyCapMicros = sharedKey ? settings.sharedKeyDailyCapMicros : settings.dailyCapMicros;

  const enabled = !account?.aiDisabledAt;
  // The statement lines that are not metered turns: subscription charges,
  // credits, refunds, write-offs. The turns are the collapsed table; these
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
  const showBalance = settings.meteringMode === "live" || owed !== 0n || otherLines.length > 0;

  return (
    <>
      <section className="card usage-card" id="ai">
        <h2>AI usage</h2>
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
              : "Nothing is billed: every request is currently free to you."}
            {lastMonth.turns > 0
              ? ` Last month it was ${dollars(lastMonth.chargeableMicros)}.`
              : null}
          </p>
        )}
        {thisMonth.ownKeyOnly && thisMonth.turns > 0 ? (
          <p className="copy">
            Every request this month ran on your own OpenAI key, so you owe us
            nothing for it. The figure above is what those tokens cost at
            OpenAI&rsquo;s list price, for your own reference.
          </p>
        ) : null}

        {showBalance ? (
          <div className="usage-block">
            <h3>Your balance</h3>
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
          </div>
        ) : null}

        <div className="usage-block">
          <details className="usage-details">
            <summary className="usage-details__summary">Where it went</summary>
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
            <p className="copy usage-block__note">
              The scene converter and store classification are always on us.
            </p>
          </details>
        </div>

        <div className="usage-block">
          <RecentAiRequests />
        </div>

        <div className="usage-block">
          <AiUsageSwitch enabled={enabled} />
        </div>
      </section>

      <section className="card usage-card">
        <h2>How pricing works</h2>
        <p className="copy">
          FrameOS Cloud is in beta. While it is, everything is free: storage,
          frames and AI usage. Nothing is charged, and you will be told before
          that changes.
        </p>
        <p className="copy">
          Once billing starts, AI usage will be priced per request: what the
          model provider charges for the tokens it used, plus our margin. The
          token counts and unit prices behind every request are kept, so each
          number on this page can be checked.
        </p>
        <p className="copy">
          You are on the <strong>{plan.plan.name}</strong> plan
          {plan.nextPlanCode ? ` (moving to ${plan.nextPlanCode} at the next renewal)` : ""}
          {plan.cancelAt ? ` (ends ${formatDateTime(plan.cancelAt)})` : ""}.
          {plan.plan.priceMicros > 0n
            ? " The plan fee is billed at the start of each period, AI usage at the end of the month."
            : ""}{" "}
          {sharedKey ? (
            <>
              Your requests run on our shared OpenAI key, with a daily
              allowance of {dollars(dailyCapMicros)}. Today you have used{" "}
              {dollars(today.chargeableMicros)} of it, and it resets at{" "}
              {formatDateTime(dayWindow.until)}. Add your own OpenAI key under
              Settings to use AI without the allowance.
            </>
          ) : (
            <>
              A daily limit of {dollars(dailyCapMicros)} applies, so a runaway
              loop can only cost a bounded amount. Today you have used{" "}
              {dollars(today.chargeableMicros)}, and it resets at{" "}
              {formatDateTime(dayWindow.until)}.
            </>
          )}
        </p>
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
