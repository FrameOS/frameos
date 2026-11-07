import {
  createDb,
  providerEvents,
  providerPayments,
  providerProducts,
  providerSubscriptions,
} from "@frameos-cloud/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { AdminNav } from "../../../../src/components/AdminNav";
import { AppShell } from "../../../../src/components/AppShell";
import { BillingNav } from "../../../../src/components/BillingNav";
import { BillingPlanSyncButton } from "../../../../src/components/BillingPlanSyncButton";
import { SortableTable } from "../../../../src/components/SortableTable";
import { requireSuperadmin } from "../../../../src/lib/admin-page";
import { describeCustomer, resolveCustomerLabels } from "../../../../src/lib/billing-admin";
import { checkoutOpenTo, postsToLedger } from "../../../../src/lib/billing-provider";
import { getAccountBaseUrl } from "../../../../src/lib/env";
import { formatDateTime, formatMicrosUsd } from "../../../../src/lib/format";
import { selfServeStops } from "../../../../src/lib/plan-catalog";
import {
  accountChecks,
  stripeProvider,
  stripeSetup,
  webhookEvents,
  type StripeAccountChecks,
} from "../../../../src/lib/stripe";

export const metadata = { title: "Payments" };
export const dynamic = "force-dynamic";

// Stripe's side of the plans (cloud/docs/billing.md): whether it is set up
// and in which mode, whether its tax and webhook settings are right, which
// plans can be bought, the money it moved and what it has told us lately.
// A webhook that failed to apply is listed with its error; nothing here
// repairs one.

function quarterStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3, 1));
}

function dashboardUrl(mode: "live" | "test", path: string): string {
  return `https://dashboard.stripe.com/${mode === "test" ? "test/" : ""}${path}`;
}

function objectPath(id: string): string | null {
  if (id.startsWith("in_")) {
    return `invoices/${id}`;
  }
  if (id.startsWith("re_") || id.startsWith("pyr_")) {
    return `refunds/${id}`;
  }
  if (id.startsWith("du_") || id.startsWith("dp_")) {
    return `disputes/${id.replace(/:fee$/, "")}`;
  }
  if (id.startsWith("txn_")) {
    return `balance/${id}`;
  }
  if (id.startsWith("sub_")) {
    return `subscriptions/${id}`;
  }
  if (id.startsWith("evt_")) {
    return `events/${id}`;
  }
  if (id.startsWith("price_")) {
    return `prices/${id}`;
  }
  return null;
}

function StripeLink({ id, mode }: { id: string; mode: "live" | "test" }) {
  const path = objectPath(id);
  return path ? (
    <a href={dashboardUrl(mode, path)} rel="noreferrer" target="_blank">
      <code>{id}</code>
    </a>
  ) : (
    <code>{id}</code>
  );
}

export default async function AdminBillingPaymentsPage() {
  await requireSuperadmin("/admin/billing/payments");
  const db = createDb();
  const setup = stripeSetup();
  const mode = setup.mode;
  const webhookUrl = new URL("/api/webhooks/stripe", getAccountBaseUrl()).toString();
  const since = quarterStart(new Date());

  const [products, subscriptions, events, payments, quarter, checks] = await Promise.all([
    db
      .select()
      .from(providerProducts)
      .where(
        and(
          eq(providerProducts.provider, stripeProvider),
          eq(providerProducts.mode, mode),
          eq(providerProducts.active, true),
        ),
      ),
    db
      .select()
      .from(providerSubscriptions)
      .where(and(eq(providerSubscriptions.provider, stripeProvider), eq(providerSubscriptions.mode, mode)))
      .orderBy(desc(providerSubscriptions.updatedAt))
      .limit(50),
    db
      .select()
      .from(providerEvents)
      .where(and(eq(providerEvents.provider, stripeProvider), eq(providerEvents.mode, mode)))
      .orderBy(desc(providerEvents.receivedAt))
      .limit(50),
    db
      .select()
      .from(providerPayments)
      .where(and(eq(providerPayments.provider, stripeProvider), eq(providerPayments.mode, mode)))
      .orderBy(desc(providerPayments.occurredAt))
      .limit(100),
    db
      .select({
        amount: sql<string>`coalesce(sum(${providerPayments.amountMicros}), 0)`,
        count: sql<number>`count(*)::int`,
        kind: providerPayments.kind,
        tax: sql<string>`coalesce(sum(${providerPayments.taxMicros}) filter (where ${providerPayments.taxRemittedBy} = 'us'), 0)`,
      })
      .from(providerPayments)
      .where(
        and(
          eq(providerPayments.provider, stripeProvider),
          eq(providerPayments.mode, mode),
          gte(providerPayments.occurredAt, since),
        ),
      )
      .groupBy(providerPayments.kind),
    setup.config
      ? accountChecks(setup.config, webhookUrl).catch((): StripeAccountChecks | null => null)
      : Promise.resolve(null),
  ]);
  const labels = await resolveCustomerLabels(db, [
    ...subscriptions.map((row) => row.accountId),
    ...payments.map((row) => row.accountId),
  ]);
  const productByPlan = new Map(products.map((row) => [row.planCode, row]));
  const stops = selfServeStops();
  const missing = stops.filter((stop) => !productByPlan.has(stop.code));
  const failed = events.filter((event) => event.error && !event.processedAt);
  const totals = (kind: string) => {
    const row = quarter.find((entry) => entry.kind === kind);
    return { amount: BigInt(row?.amount ?? "0"), count: row?.count ?? 0, tax: BigInt(row?.tax ?? "0") };
  };
  const paid = totals("payment");
  const refunded = totals("refund");
  const fees = totals("fee");

  return (
    // noCapture: the tables name customers.
    <AppShell isSuperadmin noCapture title="Payments">
      <div className="content-header">
        <div>
          <p className="copy">
            Paid plans are sold through Stripe. Raaven BV is the seller: Stripe
            charges the card, Stripe Tax adds the VAT, and that VAT is ours to
            pay over. Stripe keeps a fee from every charge. This page is what
            Stripe has told us.
          </p>
        </div>
      </div>

      <AdminNav />
      <BillingNav />

      <section className="section-block">
        <h2>Setup</h2>
        <section className="card">
          <dl className="legal-facts">
            <dt>Stripe</dt>
            <dd>
              {setup.config ? (
                <span className="pill pill-ok">Connected</span>
              ) : (
                <span className="pill pill-warning">Not set up</span>
              )}{" "}
              {setup.config
                ? `With a ${setup.config.secretKey.startsWith("rk_") ? "restricted" : "secret"} key${setup.config.apiBase ? `, at ${setup.config.apiBase.protocol}://${setup.config.apiBase.host}:${setup.config.apiBase.port}` : ""}.`
                : (setup.problem ??
                  "Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET. Until then the plan cards say “Contact support”.")}
            </dd>
            <dt>Mode</dt>
            <dd>
              <span className={mode === "live" ? "pill pill-ok" : "pill pill-warning"}>
                {mode === "live" ? "Live" : "Test"}
              </span>{" "}
              {mode === "live"
                ? "Real cards, real money, posted to the ledger."
                : postsToLedger(mode)
                  ? "Test cards only. STRIPE_TEST_LEDGER is on, so test payments post to this database's ledger."
                  : "Test cards only. A test payment grants the plan and is listed below, and never posts to the ledger."}
              {setup.config?.testClocks
                ? " Every checkout gets a customer on its own test clock: advance it in Stripe's dashboard to see a renewal."
                : ""}
            </dd>
            {setup.config ? (
              <>
                <dt>Checkout</dt>
                <dd>
                  {checkoutOpenTo(mode, false) ? (
                    <>
                      <span className="pill pill-ok">Open</span> Anyone signed in can buy a plan.
                    </>
                  ) : (
                    <>
                      <span className="pill pill-warning">Operators only</span>{" "}
                      {mode === "live"
                        ? "Everyone else sees “Contact support” on the plan cards. Make a real payment and refund it, then set STRIPE_CHECKOUT_OPEN=1 to put the plans on sale."
                        : "Everyone else sees “Contact support” on the plan cards: a test card would be a free plan. STRIPE_TEST_OPEN=1 opens it."}
                    </>
                  )}
                </dd>
              </>
            ) : null}
            <dt>Tax</dt>
            <dd>
              {setup.config ? (
                setup.config.automaticTax ? (
                  checks?.taxStatus === "active" ? (
                    <span className="pill pill-ok">Stripe Tax is on</span>
                  ) : (
                    <span className="pill pill-warning">
                      Stripe Tax is {checks?.taxStatus ?? "unknown"}
                    </span>
                  )
                ) : (
                  <span className="pill pill-warning">Off: no VAT is charged</span>
                )
              ) : null}{" "}
              Prices are{" "}
              {setup.config?.taxBehavior === "inclusive" ? "VAT included" : "before VAT, which checkout adds"}.
              A business that gives its VAT number is invoiced under the
              reverse charge. Stripe Tax files nothing: its{" "}
              <a href={dashboardUrl(mode, "tax/reporting")} rel="noreferrer" target="_blank">
                reports
              </a>{" "}
              are what the VAT return is made from.
            </dd>
            <dt>Webhook</dt>
            <dd>
              {checks ? (
                checks.webhook.found && checks.webhook.enabled && checks.webhook.missingEvents.length === 0 ? (
                  <span className="pill pill-ok">Registered</span>
                ) : (
                  <span className="pill pill-warning">
                    {!checks.webhook.found
                      ? "Not registered"
                      : !checks.webhook.enabled
                        ? "Disabled"
                        : `Missing ${checks.webhook.missingEvents.length} events`}
                  </span>
                )
              ) : null}{" "}
              <code>{webhookUrl}</code>
              {checks?.webhook.apiVersion ? (
                <>
                  {" "}
                  <span className="pill pill-warning">Sends API version {checks.webhook.apiVersion}</span>
                </>
              ) : null}
              <br />
              Add it under Developers, Webhooks in Stripe&apos;s dashboard for
              this mode, with these events, and put its signing secret in
              STRIPE_WEBHOOK_SECRET:{" "}
              {webhookEvents.map((event, index) => (
                <span key={event}>
                  {index > 0 ? ", " : ""}
                  <code>{event}</code>
                </span>
              ))}
              .
            </dd>
          </dl>
        </section>
      </section>

      <section className="section-block">
        <h2>This quarter</h2>
        <p className="section-description">
          Since {formatDateTime(since)}, in {mode} mode.
          {mode === "test" ? " Test payments are not money." : ""}
        </p>
        <section className="card">
          <dl className="legal-facts">
            <dt>Collected</dt>
            <dd>
              {formatMicrosUsd(paid.amount)} net of VAT, in {paid.count}{" "}
              {paid.count === 1 ? "payment" : "payments"}
            </dd>
            <dt>Refunded</dt>
            <dd>
              {formatMicrosUsd(refunded.amount)} net of VAT, in {refunded.count}{" "}
              {refunded.count === 1 ? "refund" : "refunds"}, lost disputes included
            </dd>
            <dt>VAT owed</dt>
            <dd>{formatMicrosUsd(paid.tax - refunded.tax)}</dd>
            <dt>Stripe&apos;s fees</dt>
            <dd>
              {formatMicrosUsd(fees.amount)}{" "}in dollars at Stripe&apos;s
              conversion rate. Stripe&apos;s Billing and Tax fees come on its
              monthly invoice, not here.
            </dd>
          </dl>
        </section>
      </section>

      <section className="section-block">
        <h2>Plans for sale</h2>
        <p className="section-description">
          Every self-serve plan of the catalog needs a price at Stripe in this
          mode. Sync creates the ones that are missing, the plan rows behind
          them and the customer portal&apos;s settings.
        </p>
        <div className="filter-bar">
          <BillingPlanSyncButton />
          {missing.length > 0 ? (
            <span className="pill pill-warning">
              {missing.length} of {stops.length} plans cannot be bought yet
            </span>
          ) : (
            <span className="pill pill-ok">All {stops.length} plans can be bought</span>
          )}
        </div>
        <SortableTable
          columns={[
            { key: "plan", label: "Plan" },
            { align: "right", key: "price", label: "Price a month" },
            { key: "product", label: "Stripe price" },
          ]}
          rows={stops.map((stop) => {
            const product = productByPlan.get(stop.code);
            return {
              cells: [
                <code>{stop.code}</code>,
                `$${stop.stop.usd}`,
                product ? (
                  <StripeLink id={product.productId} mode={mode} />
                ) : (
                  <span className="pill pill-warning">Missing</span>
                ),
              ],
              key: stop.code,
              sort: [stop.code, stop.stop.usd, product?.productId ?? ""],
            };
          })}
        />
      </section>

      {failed.length > 0 ? (
        <section className="section-block">
          <p className="notice-error" role="alert">
            {failed.length} recent {failed.length === 1 ? "notice" : "notices"} from Stripe could not
            be applied. Each is listed below with its error. Stripe sends a
            failed notice again for three days; after that, fix the cause and
            resend it from the event&apos;s page in Stripe&apos;s dashboard.
          </p>
        </section>
      ) : null}

      <section className="section-block">
        <h2>Subscriptions</h2>
        {subscriptions.length === 0 ? (
          <section className="card">
            <p>Nobody has bought a plan in {mode} mode yet.</p>
          </section>
        ) : (
          <SortableTable
            columns={[
              { key: "customer", label: "Customer" },
              { key: "plan", label: "Plan" },
              { key: "status", label: "Status" },
              { key: "period", label: "Paid until" },
              { key: "updated", label: "Last heard" },
              { key: "id", label: "Subscription" },
            ]}
            rows={subscriptions.map((row) => ({
              cells: [
                describeCustomer(labels.get(row.accountId), row.accountId),
                <code>{row.planCode ?? "?"}</code>,
                <span
                  className={
                    row.status === "active"
                      ? "pill pill-ok"
                      : row.status === "past_due" || row.status === "unpaid"
                        ? "pill pill-warning"
                        : "pill"
                  }
                >
                  {row.status}
                </span>,
                row.currentPeriodEnd ? formatDateTime(row.currentPeriodEnd) : "",
                formatDateTime(row.updatedAt),
                <StripeLink id={row.subscriptionId} mode={mode} />,
              ],
              key: row.id,
              sort: [
                describeCustomer(labels.get(row.accountId), row.accountId),
                row.planCode,
                row.status,
                row.currentPeriodEnd?.getTime(),
                row.updatedAt.getTime(),
                row.subscriptionId,
              ],
            }))}
          />
        )}
      </section>

      <section className="section-block">
        <h2>Payments, refunds and fees</h2>
        {payments.length === 0 ? (
          <section className="card">
            <p>No payments in {mode} mode yet.</p>
          </section>
        ) : (
          <SortableTable
            columns={[
              { key: "when", label: "When" },
              { key: "customer", label: "Customer" },
              { key: "kind", label: "Kind" },
              { key: "plan", label: "Plan" },
              { align: "right", key: "amount", label: "Amount" },
              { align: "right", key: "tax", label: "VAT" },
              { key: "posted", label: "In the ledger" },
              { key: "ref", label: "At Stripe" },
            ]}
            rows={payments.map((row) => {
              const invoiceNumber =
                typeof row.details["invoice_number"] === "string" ? row.details["invoice_number"] : null;
              return {
                cells: [
                  formatDateTime(row.occurredAt),
                  describeCustomer(labels.get(row.accountId), row.accountId),
                  row.kind === "refund" && row.details["kind"] === "dispute" ? "dispute lost" : row.kind,
                  <code>{row.planCode ?? "?"}</code>,
                  row.kind === "fee" ? `−${formatMicrosUsd(row.amountMicros)}` : formatMicrosUsd(row.amountMicros),
                  row.taxMicros > 0n
                    ? `${formatMicrosUsd(row.taxMicros)}${row.taxRemittedBy === "us" ? "" : " (provider's)"}`
                    : "",
                  row.posted ? "Yes" : "No (test)",
                  <>
                    <StripeLink id={row.transactionId} mode={mode} />
                    {invoiceNumber ? ` ${invoiceNumber}` : ""}
                  </>,
                ],
                key: row.id,
                sort: [
                  row.occurredAt.getTime(),
                  describeCustomer(labels.get(row.accountId), row.accountId),
                  row.kind,
                  row.planCode,
                  Number(row.amountMicros),
                  Number(row.taxMicros),
                  row.posted,
                  row.transactionId,
                ],
              };
            })}
          />
        )}
      </section>

      <section className="section-block">
        <h2>Notices from Stripe</h2>
        {events.length === 0 ? (
          <section className="card">
            <p>No webhook has arrived in {mode} mode yet.</p>
          </section>
        ) : (
          <SortableTable
            columns={[
              { key: "when", label: "Received" },
              { key: "type", label: "Event" },
              { key: "result", label: "Result" },
              { key: "id", label: "Event id" },
            ]}
            rows={events.map((row) => ({
              cells: [
                formatDateTime(row.receivedAt),
                <code>{row.eventType}</code>,
                row.processedAt ? (
                  <span className="pill pill-ok">{row.error ? "Ignored" : "Applied"}</span>
                ) : (
                  <span className="pill pill-warning">{row.error ?? "Waiting"}</span>
                ),
                <StripeLink id={row.eventId} mode={mode} />,
              ],
              key: row.id,
              sort: [row.receivedAt.getTime(), row.eventType, row.processedAt ? "applied" : (row.error ?? ""), row.eventId],
            }))}
          />
        )}
      </section>
    </AppShell>
  );
}
