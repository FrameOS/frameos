import {
  createDb,
  providerEvents,
  providerPayments,
  providerProducts,
  providerSubscriptions,
} from "@frameos-cloud/db";
import { and, desc, eq } from "drizzle-orm";
import { AdminNav } from "../../../../src/components/AdminNav";
import { AppShell } from "../../../../src/components/AppShell";
import { BillingNav } from "../../../../src/components/BillingNav";
import { BillingPlanSyncButton } from "../../../../src/components/BillingPlanSyncButton";
import { SortableTable } from "../../../../src/components/SortableTable";
import { requireSuperadmin } from "../../../../src/lib/admin-page";
import { describeCustomer, resolveCustomerLabels } from "../../../../src/lib/billing-admin";
import { postsToLedger } from "../../../../src/lib/billing-provider";
import { creemProvider, creemSetup } from "../../../../src/lib/creem";
import { getAccountBaseUrl } from "../../../../src/lib/env";
import { formatDateTime, formatMicrosUsd } from "../../../../src/lib/format";
import { selfServeStops } from "../../../../src/lib/plan-catalog";

export const metadata = { title: "Payments" };
export const dynamic = "force-dynamic";

// The payment provider's side of the plans (cloud/docs/billing.md): whether
// it is set up and in which mode, which plans can be bought, and what it has
// told us lately. A webhook that failed to apply is listed with its error;
// nothing here repairs one.
export default async function AdminBillingPaymentsPage() {
  await requireSuperadmin("/admin/billing/payments");
  const db = createDb();
  const setup = creemSetup();
  const mode = setup.mode;

  const [products, subscriptions, events, payments] = await Promise.all([
    db
      .select()
      .from(providerProducts)
      .where(
        and(
          eq(providerProducts.provider, creemProvider),
          eq(providerProducts.mode, mode),
          eq(providerProducts.active, true),
        ),
      ),
    db
      .select()
      .from(providerSubscriptions)
      .where(and(eq(providerSubscriptions.provider, creemProvider), eq(providerSubscriptions.mode, mode)))
      .orderBy(desc(providerSubscriptions.updatedAt))
      .limit(50),
    db
      .select()
      .from(providerEvents)
      .where(and(eq(providerEvents.provider, creemProvider), eq(providerEvents.mode, mode)))
      .orderBy(desc(providerEvents.receivedAt))
      .limit(50),
    db
      .select()
      .from(providerPayments)
      .where(and(eq(providerPayments.provider, creemProvider), eq(providerPayments.mode, mode)))
      .orderBy(desc(providerPayments.occurredAt))
      .limit(50),
  ]);
  const labels = await resolveCustomerLabels(db, [
    ...subscriptions.map((row) => row.accountId),
    ...payments.map((row) => row.accountId),
  ]);
  const productByPlan = new Map(products.map((row) => [row.planCode, row]));
  const stops = selfServeStops();
  const missing = stops.filter((stop) => !productByPlan.has(stop.code));
  const webhookUrl = new URL("/api/webhooks/creem", getAccountBaseUrl()).toString();
  const failed = events.filter((event) => event.error && !event.processedAt);

  return (
    // noCapture: the tables name customers.
    <AppShell isSuperadmin noCapture title="Payments">
      <div className="content-header">
        <div>
          <p className="copy">
            Paid plans are sold through Creem, a merchant of record: it charges
            the card, handles tax and pays out. This page is what it has told
            us.
          </p>
        </div>
      </div>

      <AdminNav />
      <BillingNav />

      <section className="section-block">
        <h2>Setup</h2>
        <section className="card">
          <dl className="legal-facts">
            <dt>Provider</dt>
            <dd>
              {setup.config ? (
                <span className="pill pill-ok">Connected</span>
              ) : (
                <span className="pill pill-warning">Not set up</span>
              )}{" "}
              {setup.config
                ? `Talking to ${setup.config.baseUrl}.`
                : (setup.problem ??
                  "Set CREEM_API_KEY and CREEM_WEBHOOK_SECRET. Until then the plan cards say “Contact support”.")}
            </dd>
            <dt>Mode</dt>
            <dd>
              <span className={mode === "live" ? "pill pill-ok" : "pill pill-warning"}>
                {mode === "live" ? "Live" : "Test"}
              </span>{" "}
              {mode === "live"
                ? "Real cards, real money, posted to the ledger."
                : postsToLedger(mode)
                  ? "Test cards only. CREEM_TEST_LEDGER is on, so test payments post to this database's ledger."
                  : "Test cards only. A test payment grants the plan and is listed below, and never posts to the ledger. On a production build only operators can check out."}
            </dd>
            <dt>Webhook URL</dt>
            <dd>
              <code>{webhookUrl}</code>
              <br />
              Register it under Developers, Webhooks in the Creem dashboard for
              this mode, and put its signing secret in CREEM_WEBHOOK_SECRET.
            </dd>
          </dl>
        </section>
      </section>

      <section className="section-block">
        <h2>Plans for sale</h2>
        <p className="section-description">
          Every self-serve plan of the catalog needs a product at the provider
          in this mode. Sync creates the ones that are missing and the plan
          rows behind them.
        </p>
        <div className="filter-bar">
          <BillingPlanSyncButton disabled={!setup.config} />
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
            { key: "product", label: "Product" },
          ]}
          rows={stops.map((stop) => {
            const product = productByPlan.get(stop.code);
            return {
              cells: [
                <code>{stop.code}</code>,
                `$${stop.stop.usd}`,
                product ? <code>{product.productId}</code> : <span className="pill pill-warning">Missing</span>,
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
            {failed.length} recent {failed.length === 1 ? "notice" : "notices"} from the provider could
            not be applied. Each is listed below with its error. The provider
            sends a failed notice again for a day; after that, fix the cause
            and resend it from the Creem dashboard.
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
            ]}
            rows={subscriptions.map((row) => ({
              cells: [
                describeCustomer(labels.get(row.accountId), row.accountId),
                <code>{row.planCode ?? "?"}</code>,
                <span className={row.status === "active" ? "pill pill-ok" : "pill"}>{row.status}</span>,
                row.currentPeriodEnd ? formatDateTime(row.currentPeriodEnd) : "",
                formatDateTime(row.updatedAt),
              ],
              key: row.id,
              sort: [
                describeCustomer(labels.get(row.accountId), row.accountId),
                row.planCode,
                row.status,
                row.currentPeriodEnd?.getTime(),
                row.updatedAt.getTime(),
              ],
            }))}
          />
        )}
      </section>

      <section className="section-block">
        <h2>Payments and refunds</h2>
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
              { align: "right", key: "amount", label: "Net of tax" },
              { align: "right", key: "tax", label: "Tax" },
              { key: "posted", label: "In the ledger" },
            ]}
            rows={payments.map((row) => ({
              cells: [
                formatDateTime(row.occurredAt),
                describeCustomer(labels.get(row.accountId), row.accountId),
                row.kind,
                <code>{row.planCode ?? "?"}</code>,
                formatMicrosUsd(row.amountMicros),
                formatMicrosUsd(row.taxMicros),
                row.posted ? "Yes" : "No (test)",
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
              ],
            }))}
          />
        )}
      </section>

      <section className="section-block">
        <h2>Notices from the provider</h2>
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
                  <span className="pill pill-ok">Applied</span>
                ) : (
                  <span className="pill pill-warning">{row.error ?? "Waiting"}</span>
                ),
                <code>{row.eventId}</code>,
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
