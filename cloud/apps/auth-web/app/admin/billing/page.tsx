import Link from "next/link";
import { createDb } from "@frameos-cloud/db";
import {
  absorbedSurfaces,
  aiUsageSummary,
  checkLedgerIntegrity,
  dailySummary,
  readBillingSettings,
  readRawBillingSettings,
  trialBalance,
  type TrialBalanceRow,
} from "@frameos-cloud/ledger";
import { AdminNav } from "../../../src/components/AdminNav";
import { AppShell } from "../../../src/components/AppShell";
import { BillingNav } from "../../../src/components/BillingNav";
import { BillingSettingsForm } from "../../../src/components/BillingSettingsForm";
import { requireSuperadmin } from "../../../src/lib/admin-page";
import {
  describeCustomer,
  ownerOfAccountCode,
  resolveCustomerLabels,
} from "../../../src/lib/billing-admin";
import { formatDateTime, formatMicrosUsd } from "../../../src/lib/format";

export const metadata = { title: "Billing" };
export const dynamic = "force-dynamic";

// The trial balance: every account with its debit and credit totals, and the
// one equality the whole system rests on printed at the bottom. Read
// straight off the postings rather than off ledger_balances — a report that
// trusted the cache could not notice the cache had gone wrong, and noticing
// that is half of what this page is for.
//
// The invariants run on every render. They are cheap at our size, and the
// failure mode of accounting bugs is silence: a page that only shows numbers
// would look exactly the same whether or not the books held together.
export default async function AdminBillingPage() {
  await requireSuperadmin("/admin/billing");
  const db = createDb();

  const settings = await readBillingSettings(db);
  const stored = await readRawBillingSettings(db);
  const editors = await resolveCustomerLabels(
    db,
    stored.map((row) => row.updatedBy),
  );
  const window = {
    since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    until: new Date(),
  };
  const [balance, violations, summary, usage] = await Promise.all([
    trialBalance(db),
    // Every check the nightly job runs, with the same inputs: the page used
    // to leave the cap out and still say "All checks pass" (§9.2 item 8).
    checkLedgerIntegrity(db, {
      dailyCapMicros: settings.dailyCapMicros,
      overdraftMicros: settings.overdraftMicros,
    }),
    dailySummary(db, window),
    aiUsageSummary(db, window),
  ]);
  const listCostTotal = usage.reduce((sum, row) => sum + row.listCostMicros, 0n);

  const groups = new Map<string, TrialBalanceRow[]>();
  for (const row of balance.rows) {
    const key = row.groupName ?? "Ungrouped";
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  return (
    // noCapture: customer subaccount codes carry account uuids.
    <AppShell isSuperadmin noCapture title="Billing">
      <div className="content-header">
        <div>
          <p className="copy">
            The books, straight from the postings. Every number here drills
            into the entries behind it; nothing on this page is stored
            anywhere but as journal lines.
          </p>
        </div>
      </div>

      <AdminNav />
      <BillingNav />

      <section className="section-block">
        <div className="stat-grid">
          <div className="stat-tile">
            <div className="stat-tile__label">Revenue, 30 days</div>
            <div className="stat-tile__value">
              {formatMicrosUsd(summary.netRevenueMicros)}
            </div>
            <div className="stat-tile__detail">
              {formatMicrosUsd(summary.revenueMicros)} earned less{" "}
              {formatMicrosUsd(summary.contraRevenueMicros)} of credit granted.
            </div>
          </div>
          <div className="stat-tile">
            <div className="stat-tile__label">Provider cost, 30 days</div>
            <div className="stat-tile__value">{formatMicrosUsd(summary.cogsMicros)}</div>
          </div>
          <div className="stat-tile">
            <div className="stat-tile__label">Margin, 30 days</div>
            <div className="stat-tile__value">{formatMicrosUsd(summary.marginMicros)}</div>
            <div className="stat-tile__detail">
              Never stored: net revenue less what the provider charged us.
              {summary.pspFeesMicros !== 0n || summary.badDebtMicros !== 0n
                ? ` Below it: ${formatMicrosUsd(summary.pspFeesMicros)} of payment fees and ${formatMicrosUsd(summary.badDebtMicros)} written off.`
                : null}
            </div>
          </div>
          <div className="stat-tile">
            <div className="stat-tile__label">Owed by customers</div>
            <div className="stat-tile__value">
              {formatMicrosUsd(summary.customerReceivableMicros)}
            </div>
            <div className="stat-tile__detail">
              Metered usage and subscriptions accrued but not yet invoiced —
              postpay&rsquo;s receivable, and what a month-end run collects.
            </div>
          </div>
          {summary.customerLiabilityMicros !== 0n ? (
            <div className="stat-tile">
              <div className="stat-tile__label">Owed to customers</div>
              <div className="stat-tile__value">
                {formatMicrosUsd(summary.customerLiabilityMicros)}
              </div>
              <div className="stat-tile__detail">
                Prepaid credit not yet spent. Zero unless the shelved prepaid
                model is in use — shown only when it is not.
              </div>
            </div>
          ) : null}
        </div>
      </section>

      <section className="section-block">
        <h2>AI usage, 30 days</h2>
        <p className="section-description">
          Every metered turn, priced at the snapshot rates — whoever paid the
          provider. Only the <code>shared</code> and <code>platform</code>
          rows are the platform&apos;s own cost and reach the trial balance; a
          turn on the customer&apos;s <code>account</code> key is real usage
          that cost us nothing, because they paid OpenAI directly. This is the
          column to reconcile against PostHog and the provider invoice.
        </p>
        <p className="section-description">
          Split by surface, because a surface marked <em>absorbed</em> is one
          we pay for on purpose and never charge for — scene conversion is our
          own migration off compiled scenes — and the price of a giveaway
          should be a number somebody can read, not a decision buried in a
          route that happens not to bill.
        </p>
        {usage.length === 0 ? (
          <section className="card">
            <p>No AI usage metered in the window.</p>
          </section>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Paid by</th>
                  <th>Surface</th>
                  <th>Mode</th>
                  <th style={{ textAlign: "right" }}>Turns</th>
                  <th style={{ textAlign: "right" }}>Tokens (in / cached / out)</th>
                  <th style={{ textAlign: "right" }}>At list prices</th>
                  <th style={{ textAlign: "right" }}>Our cost</th>
                  <th style={{ textAlign: "right" }}>Priced to customers</th>
                </tr>
              </thead>
              <tbody>
                {usage.map((row) => (
                  <tr key={`${row.credentialSource}:${row.meteringMode}:${row.surface ?? ""}`}>
                    <td>
                      {row.credentialSource === "account"
                        ? "the customer (own key)"
                        : row.credentialSource === "shared"
                          ? "us (operator key)"
                          : "us (platform key, billable)"}
                    </td>
                    <td className="copy">
                      {row.surface ?? "—"}
                      {row.surface && absorbedSurfaces.includes(row.surface) ? " (absorbed)" : ""}
                    </td>
                    <td>
                      <span className="pill">{row.meteringMode}</span>
                    </td>
                    <td style={{ textAlign: "right" }}>{row.turns.toString()}</td>
                    <td className="copy" style={{ textAlign: "right" }}>
                      {row.inputTokens.toString()} / {row.cachedInputTokens.toString()} /{" "}
                      {row.outputTokens.toString()}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {formatMicrosUsd(row.listCostMicros)}
                    </td>
                    <td style={{ textAlign: "right" }}>{formatMicrosUsd(row.costMicros)}</td>
                    <td style={{ textAlign: "right" }}>{formatMicrosUsd(row.priceMicros)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={5}>Total at list prices</th>
                  <th style={{ textAlign: "right" }}>{formatMicrosUsd(listCostTotal)}</th>
                  <th colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      <section className="section-block">
        <h2>Consistency</h2>
        <p className="section-description">
          The same checks the nightly job runs and the test suite proves,
          against live data.
        </p>
        {violations.length === 0 ? (
          <section className="card">
            <p>
              <span className="pill pill-ok">All checks pass</span> Every entry
              balances, the accounting equation holds, the balance cache
              matches the postings, no account-day ran past the cap, deferred
              subscription revenue matches its periods, recent turns priced
              off the price table, and the append-only triggers are installed.
            </p>
          </section>
        ) : (
          <div className="notice-error" role="alert">
            <ul>
              {violations.map((violation) => (
                <li key={`${violation.check}:${violation.detail}`}>
                  <strong>{violation.check}</strong>: {violation.detail}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="section-block">
        <h2>Trial balance</h2>
        <p className="section-description">
          {settings.meteringMode === "shadow"
            ? "Metering is in shadow mode: turns are measured and priced, and nothing is posted."
            : "Metering is live: every billable turn posts to the journal."}
        </p>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Type</th>
                <th style={{ textAlign: "right" }}>Debits</th>
                <th style={{ textAlign: "right" }}>Credits</th>
                <th style={{ textAlign: "right" }}>Balance</th>
              </tr>
            </thead>
            {[...groups.entries()].map(([groupName, rows]) => (
              <tbody key={groupName}>
                <tr>
                  <th colSpan={5}>{groupName}</th>
                </tr>
                {rows.map((row) => {
                  const owner = ownerOfAccountCode(row.accountCode);
                  return (
                    <tr key={row.ledgerAccountId}>
                      <td>
                        <Link
                          href={
                            owner
                              ? `/admin/billing/customers?account=${owner}`
                              : `/admin/billing/journal?account=${encodeURIComponent(row.accountCode)}`
                          }
                        >
                          {row.accountCode}
                        </Link>
                        {row.cachedBalanceMicros === row.balanceMicros ? null : (
                          <span className="risk-badge">cache disagrees</span>
                        )}
                      </td>
                      <td className="copy">{row.type}</td>
                      <td style={{ textAlign: "right" }}>
                        {formatMicrosUsd(row.debitMicros)}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        {formatMicrosUsd(row.creditMicros)}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        {formatMicrosUsd(row.balanceMicros)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            ))}
            <tfoot>
              <tr>
                <th colSpan={2}>
                  Total{" "}
                  {balance.balanced ? (
                    <span className="pill pill-ok">balanced</span>
                  ) : (
                    <span className="risk-badge">OUT OF BALANCE</span>
                  )}
                </th>
                <th style={{ textAlign: "right" }}>
                  {formatMicrosUsd(balance.totalDebitMicros)}
                </th>
                <th style={{ textAlign: "right" }}>
                  {formatMicrosUsd(balance.totalCreditMicros)}
                </th>
                <th />
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <section className="section-block">
        <h2>Settings</h2>
        <p className="section-description">
          Every change here is audited and forward-looking only.
        </p>
        {stored.length > 0 ? (
          <p className="copy">
            Last changed:{" "}
            {stored
              .map(
                (row) =>
                  `${row.key} by ${
                    row.updatedBy
                      ? describeCustomer(editors.get(row.updatedBy), row.updatedBy)
                      : "the migration"
                  } on ${formatDateTime(row.updatedAt)}`,
              )
              .join(" · ")}
          </p>
        ) : null}
        <section className="card">
          <BillingSettingsForm
            values={{
              aiMarginPercent: String(settings.marginBasisPoints / 100),
              dailyCapMicros: settings.dailyCapMicros.toString(),
              meteringMode: settings.meteringMode,
              overdraftMicros: settings.overdraftMicros.toString(),
            }}
          />
        </section>
      </section>
    </AppShell>
  );
}
