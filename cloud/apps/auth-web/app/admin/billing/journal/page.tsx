import Link from "next/link";
import { createDb, ledgerAccounts } from "@frameos-cloud/db";
import { listJournalEntries } from "@frameos-cloud/ledger";
import { asc } from "drizzle-orm";
import { AdminNav } from "../../../../src/components/AdminNav";
import { AppShell } from "../../../../src/components/AppShell";
import { BillingNav } from "../../../../src/components/BillingNav";
import { JournalEntryActions } from "../../../../src/components/JournalEntryActions";
import { JournalPostForm } from "../../../../src/components/JournalPostForm";
import { requireSuperadmin } from "../../../../src/lib/admin-page";
import { isAccountUuid } from "../../../../src/lib/billing-admin";
import { formatDateTime, formatMicrosUsd } from "../../../../src/lib/format";

export const metadata = { title: "Journal" };
export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function first(
  params: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const raw = Array.isArray(params[key]) ? params[key][0] : params[key];
  return raw?.trim() || undefined;
}

// Every entry, newest first, with its legs and the fact that produced it.
//
// The drill-down is the point: a number in the trial balance links here
// filtered to its account, an entry links to the event it came from, and the
// event's idempotency key is the handle back into the product ("turn:<uuid>"
// is a chat turn, and the turn id is in the logs). One chain from a total to
// the thing that happened.
export default async function AdminBillingJournalPage({ searchParams }: PageProps) {
  await requireSuperadmin("/admin/billing/journal");
  const params = searchParams ? await searchParams : {};
  const db = createDb();

  const accountCode = first(params, "account");
  const entryType = first(params, "type");
  // Validated, not passed through: it reaches the query as ::uuid, and a
  // malformed one from the address bar would be a 500 rather than an empty
  // list.
  const eventParam = first(params, "event");
  const eventId = isAccountUuid(eventParam) ? eventParam : undefined;
  const owner = first(params, "owner");

  const entries = await listJournalEntries(db, {
    ...(accountCode ? { accountCode } : {}),
    ...(entryType ? { entryType } : {}),
    ...(eventId ? { eventId } : {}),
    ...(isAccountUuid(owner) ? { ownerAccountId: owner } : {}),
    limit: 200,
  });
  const accountCodes = (
    await db
      .select({ code: ledgerAccounts.code })
      .from(ledgerAccounts)
      .orderBy(asc(ledgerAccounts.code))
  ).map((row) => row.code);

  const filtered = Boolean(accountCode || entryType || eventId || owner);

  return (
    // noCapture: entry descriptions and account codes carry customer data.
    <AppShell isSuperadmin noCapture title="Journal">
      <div className="content-header">
        <div>
          <p className="copy">
            Every journal entry, newest first. Nothing here was ever edited:
            corrections are reversals and reclassifications posted beside the
            original.
          </p>
        </div>
      </div>

      <AdminNav />
      <BillingNav />

      <section className="section-block">
        <form action="/admin/billing/journal" className="inline-actions" method="get">
          <input
            aria-label="Account code"
            className="input"
            defaultValue={accountCode ?? ""}
            name="account"
            placeholder="Account code"
          />
          <input
            aria-label="Entry type"
            className="input"
            defaultValue={entryType ?? ""}
            name="type"
            placeholder="Entry type, e.g. ai_usage_charge"
          />
          <input
            aria-label="Customer account uuid"
            className="input"
            defaultValue={owner ?? ""}
            name="owner"
            placeholder="Customer account uuid"
          />
          <button className="button" type="submit">
            Filter
          </button>
          {filtered ? (
            <Link className="button button--subtle" href="/admin/billing/journal">
              Clear
            </Link>
          ) : null}
        </form>
      </section>

      <section className="section-block">
        {entries.length === 0 ? (
          <section className="card">
            <p>
              {filtered
                ? "No entries match that filter."
                : "The journal is empty. Nothing has posted yet."}
            </p>
          </section>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Entry</th>
                  <th>Legs</th>
                  <th>Source</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="copy">{formatDateTime(entry.occurredAt)}</td>
                    <td>
                      <Link
                        href={`/admin/billing/journal?type=${encodeURIComponent(entry.entryType)}`}
                      >
                        {entry.entryType}
                      </Link>
                      <div className="copy">{entry.description}</div>
                      {entry.externalRef ? (
                        <div className="copy">ref {entry.externalRef}</div>
                      ) : null}
                    </td>
                    <td>
                      {entry.postings.map((posting, index) => (
                        <div key={`${entry.id}:${index}`}>
                          {posting.direction === "debit" ? "Dr" : "Cr"}{" "}
                          <Link
                            href={`/admin/billing/journal?account=${encodeURIComponent(posting.accountCode)}`}
                          >
                            {posting.accountCode}
                          </Link>{" "}
                          {formatMicrosUsd(posting.amountMicros)}
                        </div>
                      ))}
                    </td>
                    <td className="copy">
                      <Link href={`/admin/billing/journal?event=${entry.eventId}`}>
                        {entry.eventType}
                      </Link>
                      <div>{entry.eventIdempotencyKey}</div>
                      <div>
                        via {entry.eventSource}, rule v{entry.ruleVersion}
                      </div>
                      {Object.keys(entry.metadata).length > 0 ? (
                        <details>
                          <summary>Pricing snapshot</summary>
                          <pre>{JSON.stringify(entry.metadata, null, 2)}</pre>
                        </details>
                      ) : null}
                    </td>
                    <td>
                      <JournalEntryActions
                        accountId={
                          entry.postings.find((posting) => posting.ownerAccountId)
                            ?.ownerAccountId ?? null
                        }
                        entryId={entry.id}
                        reversedByEntryId={entry.reversedByEntryId}
                        reversesEntryId={entry.reversesEntryId}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="section-block">
        <h2>Post an entry by hand</h2>
        <p className="section-description">
          Goes through the same posting kernel as everything else — an event,
          idempotent, reversible, and audited. There is no path that writes a
          posting directly.
        </p>
        <section className="card">
          <JournalPostForm accountCodes={accountCodes} />
        </section>
      </section>
    </AppShell>
  );
}
