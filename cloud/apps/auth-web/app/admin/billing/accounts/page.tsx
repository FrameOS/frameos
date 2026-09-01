import Link from "next/link";
import { createDb, ledgerAccounts } from "@frameos-cloud/db";
import { listAccountGroups } from "@frameos-cloud/ledger";
import { asc, isNull } from "drizzle-orm";
import { AdminNav } from "../../../../src/components/AdminNav";
import { AppShell } from "../../../../src/components/AppShell";
import { BillingNav } from "../../../../src/components/BillingNav";
import {
  CreateLedgerGroupForm,
  LedgerAccountGroupSelect,
} from "../../../../src/components/LedgerGroupControls";
import { requireSuperadmin } from "../../../../src/lib/admin-page";
import { formatDate } from "../../../../src/lib/format";

export const metadata = { title: "Chart of accounts" };
export const dynamic = "force-dynamic";

// The chart, and the reporting groups it hangs off.
//
// Only system accounts are listed. Per-customer subaccounts are created on
// first touch and there is one per customer per kind — thousands of them
// eventually, all of the same shape, none of them ever regrouped by hand.
// The Customer statement view is where those are read.
export default async function AdminBillingAccountsPage() {
  await requireSuperadmin("/admin/billing/accounts");
  const db = createDb();

  const [groups, accounts] = await Promise.all([
    listAccountGroups(db),
    db
      .select()
      .from(ledgerAccounts)
      .where(isNull(ledgerAccounts.ownerAccountId))
      .orderBy(asc(ledgerAccounts.code)),
  ]);
  const groupOptions = groups.map((group) => ({ id: group.id, name: group.name }));

  return (
    <AppShell isSuperadmin title="Chart of accounts">
      <div className="content-header">
        <div>
          <p className="copy">
            The system accounts posting rules name. Moving one to another
            group re-buckets every report and touches no posting — moving an{" "}
            <em>amount</em> is a reclassification on the{" "}
            <Link href="/admin/billing/journal">Journal</Link> page.
          </p>
        </div>
      </div>

      <AdminNav />
      <BillingNav />

      <section className="section-block">
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Type</th>
                <th>Normal side</th>
                <th>Reporting group</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id}>
                  <td>
                    <Link
                      href={`/admin/billing/journal?account=${encodeURIComponent(account.code)}`}
                    >
                      {account.code}
                    </Link>
                  </td>
                  <td className="copy">{account.type}</td>
                  <td className="copy">{account.normalSide}</td>
                  <td>
                    <LedgerAccountGroupSelect
                      groupId={account.groupId}
                      groups={groupOptions}
                      ledgerAccountId={account.id}
                    />
                  </td>
                  <td className="copy">{formatDate(account.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section-block">
        <h2>Reporting groups</h2>
        <p className="section-description">
          Presentation only. Renaming or re-mapping costs nothing and can be
          undone by doing it again.
        </p>
        <section className="card">
          <ul>
            {groups.map((group) => (
              <li key={group.id}>
                <strong>{group.name}</strong> <span className="copy">{group.code}</span>
              </li>
            ))}
          </ul>
          <CreateLedgerGroupForm />
        </section>
      </section>
    </AppShell>
  );
}
