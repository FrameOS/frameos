import Link from "next/link";
import { accounts, aiUsageRecords, createDb, ledgerAccounts } from "@frameos-cloud/db";
import {
  customerCreditsCode,
  customerPromoCreditsCode,
  customerReceivableCode,
  customerStatement,
  listPlans,
  readAccountPlan,
} from "@frameos-cloud/ledger";
import { desc, eq, isNotNull } from "drizzle-orm";
import { AdminNav } from "../../../../src/components/AdminNav";
import { AppShell } from "../../../../src/components/AppShell";
import { BillingNav } from "../../../../src/components/BillingNav";
import {
  CustomerAiSwitch,
  CustomerPlanForm,
} from "../../../../src/components/CustomerBillingControls";
import { requireSuperadmin } from "../../../../src/lib/admin-page";
import {
  describeCustomer,
  isAccountUuid,
  resolveCustomerLabels,
} from "../../../../src/lib/billing-admin";
import { formatDateTime, formatMicrosUsd } from "../../../../src/lib/format";

export const metadata = { title: "Customer statement" };
export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

// One customer's books, oldest first, with a running balance: the view
// support needs when somebody asks what they owe and why. Under postpay
// that is the receivable (§3.1); the prepaid and promo statements are the
// shelved model (§3.5) and only appear if something ever posted to them.
//
// It is also where the operator's two hands on an account live (§5.1
// "Superadmin side", §9.3): the AI switch — dunning's terminal step — and
// the plan, for the arrangements no self-serve button covers.
//
// The name at the top is resolved live from `accounts` and degrades to the
// bare uuid when nothing matches. That is not a gap to fix — the ledger
// deliberately holds a uuid and nothing else about the person, so that
// erasure can take everything that names them while the books stay complete
// and still attributed. A statement headed "deleted account" is the system
// telling the truth.
export default async function AdminBillingCustomersPage({ searchParams }: PageProps) {
  await requireSuperadmin("/admin/billing/customers");
  const params = searchParams ? await searchParams : {};
  const raw = Array.isArray(params.account) ? params.account[0] : params.account;
  const accountId = isAccountUuid(raw?.trim()) ? raw!.trim().toLowerCase() : null;
  const db = createDb();

  // Everyone with books, so the page is usable without knowing a uuid.
  const known = await db
    .selectDistinct({ ownerAccountId: ledgerAccounts.ownerAccountId })
    .from(ledgerAccounts)
    .where(isNotNull(ledgerAccounts.ownerAccountId));
  const labels = await resolveCustomerLabels(
    db,
    [...known.map((row) => row.ownerAccountId), accountId],
  );

  const [receivable, paid, promo, usage, plan, plans, [account]] = accountId
    ? await Promise.all([
        customerStatement(db, customerReceivableCode(accountId)),
        customerStatement(db, customerCreditsCode(accountId)),
        customerStatement(db, customerPromoCreditsCode(accountId)),
        db
          .select()
          .from(aiUsageRecords)
          .where(eq(aiUsageRecords.accountId, accountId))
          .orderBy(desc(aiUsageRecords.createdAt))
          .limit(50),
        readAccountPlan(db, accountId),
        listPlans(db),
        db
          .select({ aiDisabledAt: accounts.aiDisabledAt, id: accounts.id })
          .from(accounts)
          .where(eq(accounts.id, accountId))
          .limit(1),
      ])
    : [null, null, null, [], null, [], []];

  return (
    // noCapture: this page is one customer's email and their spending.
    <AppShell isSuperadmin noCapture title="Customer statement">
      <div className="content-header">
        <div>
          <p className="copy">
            What a customer owes, entry by entry, the metered turns behind
            it, and the operator&apos;s controls: their plan and their AI
            switch.
          </p>
        </div>
      </div>

      <AdminNav />
      <BillingNav />

      <section className="section-block">
        <form action="/admin/billing/customers" className="inline-actions" method="get">
          <input
            aria-label="Account uuid"
            className="input"
            defaultValue={accountId ?? ""}
            name="account"
            placeholder="Account uuid"
          />
          <button className="button" type="submit">
            Show
          </button>
        </form>
        {known.length > 0 ? (
          <p className="copy">
            Accounts with books:{" "}
            {known.map((row, index) => {
              const owner = row.ownerAccountId!;
              return (
                <span key={owner}>
                  {index > 0 ? ", " : ""}
                  <Link href={`/admin/billing/customers?account=${owner}`}>
                    {describeCustomer(labels.get(owner), owner)}
                  </Link>
                </span>
              );
            })}
          </p>
        ) : null}
      </section>

      {accountId ? (
        <>
          <section className="section-block">
            <h2>{describeCustomer(labels.get(accountId), accountId)}</h2>
            <p className="section-description">
              Account {accountId} ·{" "}
              <Link href={`/admin/billing/journal?owner=${accountId}`}>
                every entry that names them
              </Link>
            </p>
            {[
              { statement: receivable, title: "Owed to us" },
              { statement: paid, title: "Prepaid credit" },
              { statement: promo, title: "Granted credit" },
            ]
              // The prepaid statements are the shelved model (§3.5): shown
              // only when something once posted there, so the page does
              // not open with two "nothing has ever posted" cards.
              .filter(({ statement, title }) => title === "Owed to us" || (statement?.lines.length ?? 0) > 0)
              .map(({ statement, title }) => (
              <div key={title}>
                <h3>
                  {title}: {formatMicrosUsd(statement?.closingBalanceMicros ?? 0n)}
                </h3>
                {!statement || statement.lines.length === 0 ? (
                  <section className="card">
                    <p>Nothing has ever posted to this account.</p>
                  </section>
                ) : (
                  <div className="table-scroll">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>When</th>
                          <th>Entry</th>
                          <th style={{ textAlign: "right" }}>Change</th>
                          <th style={{ textAlign: "right" }}>Balance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {statement.lines.map((line, index) => (
                          <tr key={`${line.entryId}:${index}`}>
                            <td className="copy">{formatDateTime(line.occurredAt)}</td>
                            <td>
                              {line.entryType}
                              <div className="copy">{line.description}</div>
                            </td>
                            <td style={{ textAlign: "right" }}>
                              {line.direction === "credit" ? "+" : "−"}
                              {formatMicrosUsd(line.amountMicros)}
                            </td>
                            <td style={{ textAlign: "right" }}>
                              {formatMicrosUsd(line.balanceMicros)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
          </section>

          {account ? (
            <section className="section-block">
              <h2>Plan and AI switch</h2>
              <p className="section-description">
                On the <strong>{plan?.plan.name ?? "Pay as you go"}</strong> plan
                {plan?.subscribed ? "" : " (no subscription row — the default)"}
                {plan?.nextPlanCode ? `, moving to ${plan.nextPlanCode} at the rollover` : ""}
                {plan?.cancelAt ? `, ends ${formatDateTime(plan.cancelAt)}` : ""}.
                Both actions below are audited with the reason given;{" "}
                <Link href={`/admin/users?q=${encodeURIComponent(describeCustomer(labels.get(accountId), accountId))}`}>
                  the activity feed
                </Link>{" "}
                is where to read them back.
              </p>
              <section className="card">
                <h3>Plan</h3>
                <CustomerPlanForm
                  accountId={accountId}
                  currentCode={plan?.plan.code ?? "payg"}
                  plans={plans.map((entry) => ({
                    code: entry.code,
                    name: entry.name,
                    priceMicros: entry.priceMicros.toString(),
                    public: entry.public,
                  }))}
                  subscribed={plan?.subscribed ?? false}
                />
              </section>
              <section className="card">
                <h3>AI switch</h3>
                <CustomerAiSwitch
                  accountId={accountId}
                  disabledAt={account.aiDisabledAt?.toISOString() ?? null}
                />
              </section>
            </section>
          ) : (
            <section className="section-block">
              <section className="card">
                <p>
                  No account row: this customer was erased. Their books stay;
                  there is no plan or switch left to operate.
                </p>
              </section>
            </section>
          )}

          <section className="section-block">
            <h2>Metered turns</h2>
            <p className="section-description">
              The measurement behind the charges. A turn on the customer&apos;s
              own key is recorded here and posts nothing — they paid the
              provider directly.
            </p>
            {usage.length === 0 ? (
              <section className="card">
                <p>No AI usage recorded for this account.</p>
              </section>
            ) : (
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Surface</th>
                      <th>Model</th>
                      <th>Key</th>
                      <th>Tokens (in / cached / out)</th>
                      <th style={{ textAlign: "right" }}>Cost</th>
                      <th style={{ textAlign: "right" }}>Price</th>
                      <th>Posted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.map((record) => (
                      <tr key={record.id}>
                        <td className="copy">{formatDateTime(record.occurredAt)}</td>
                        <td className="copy">{record.surface ?? "—"}</td>
                        <td className="copy">{record.model}</td>
                        <td className="copy">{record.credentialSource}</td>
                        <td className="copy">
                          {record.inputTokens} / {record.cachedInputTokens} /{" "}
                          {record.outputTokens}
                        </td>
                        <td style={{ textAlign: "right" }}>
                          {formatMicrosUsd(record.costMicros)}
                        </td>
                        <td style={{ textAlign: "right" }}>
                          {formatMicrosUsd(record.priceMicros)}
                        </td>
                        <td>
                          {record.eventId ? (
                            <Link href={`/admin/billing/journal?event=${record.eventId}`}>
                              entries
                            </Link>
                          ) : (
                            <span className="pill">{record.meteringMode}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : (
        <section className="section-block">
          <section className="card">
            <p>
              Pick an account above, or follow a customer subaccount from the{" "}
              <Link href="/admin/billing">trial balance</Link>.
            </p>
          </section>
        </section>
      )}
    </AppShell>
  );
}
