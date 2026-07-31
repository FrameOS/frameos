import { redirect } from "next/navigation";
import { createDb } from "@frameos-cloud/db";
import { AdminNav } from "../../src/components/AdminNav";
import {
  AdminUsersTable,
  type AdminUser,
} from "../../src/components/AdminUsersTable";
import { AppShell } from "../../src/components/AppShell";
import {
  getSuperadminContext,
  listAccountsForAdmin,
} from "../../src/lib/admin";
import { runSystemChecks } from "../../src/lib/system-checks";

export const metadata = { title: "Users" };

type AdminPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminPage({ searchParams }: AdminPageProps) {
  const context = await getSuperadminContext();
  if (context.kind === "unauthenticated") {
    redirect("/login?return_to=/admin");
  }
  if (context.kind === "forbidden") {
    redirect("/account");
  }

  const params = searchParams ? await searchParams : {};
  const rawQuery = Array.isArray(params.q) ? params.q[0] : params.q;
  const query = rawQuery?.trim() || undefined;

  const rows = await listAccountsForAdmin(createDb(), query);
  const users: AdminUser[] = rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
  }));

  return (
    <AppShell isSuperadmin title="Users">
      <div className="content-header">
        <div>
          <p className="copy">
            Manage FrameOS Cloud accounts. Only superadmins can see this page.
          </p>
        </div>
      </div>

      <AdminNav />

      <section className="section-block">
        <form action="/admin" className="inline-actions" method="get">
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

        <AdminUsersTable selfAccountId={context.accountId} users={users} />
      </section>

      <section className="section-block">
        <div className="content-header compact-header">
          <div>
            <h2>System checks</h2>
            <p className="copy">
              Configuration this instance runs with. Only presence is shown,
              never values.
            </p>
          </div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Setting</th>
              <th>Status</th>
              <th>What it does</th>
            </tr>
          </thead>
          <tbody>
            {runSystemChecks().map((check) => (
              <tr key={check.name}>
                <td>
                  <code>{check.name}</code>
                </td>
                <td>
                  <span
                    className={
                      check.configured
                        ? "pill pill-ok"
                        : check.required
                          ? "pill pill-warning"
                          : "pill"
                    }
                  >
                    {check.configured
                      ? "Configured"
                      : check.required
                        ? "Missing"
                        : "Not set"}
                  </span>
                </td>
                <td className="copy">{check.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </AppShell>
  );
}
