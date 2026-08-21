import { createDb } from "@frameos-cloud/db";
import { AdminNav } from "../../../src/components/AdminNav";
import {
  AdminUsersTable,
  type AdminUser,
} from "../../../src/components/AdminUsersTable";
import { AppShell } from "../../../src/components/AppShell";
import { listAccountsForAdmin } from "../../../src/lib/admin";
import { requireSuperadmin, searchQueryOf } from "../../../src/lib/admin-page";

export const metadata = { title: "Users" };

type AdminUsersPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminUsersPage({
  searchParams,
}: AdminUsersPageProps) {
  const accountId = await requireSuperadmin("/admin/users");
  const query = searchQueryOf(searchParams ? await searchParams : {});

  const rows = await listAccountsForAdmin(createDb(), query);
  const users: AdminUser[] = rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
  }));

  return (
    // noCapture: this table lists every account's email address.
    <AppShell isSuperadmin noCapture title="Users">
      <div className="content-header">
        <div>
          <p className="copy">
            Every account, newest first. Backends, frames and scenes read
            &quot;active / total&quot;; hover a number for the breakdown.
          </p>
        </div>
      </div>

      <AdminNav />

      <section className="section-block">
        <form action="/admin/users" className="inline-actions" method="get">
          <input
            className="input"
            defaultValue={query ?? ""}
            name="q"
            placeholder="Search by email or name"
            type="search"
          />
          <button className="button" type="submit">
            Search
          </button>
        </form>

        <AdminUsersTable selfAccountId={accountId} users={users} />
      </section>
    </AppShell>
  );
}
