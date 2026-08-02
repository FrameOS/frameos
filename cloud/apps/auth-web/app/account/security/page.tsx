import { eq } from "drizzle-orm";
import { accounts, createDb } from "@frameos-cloud/db";
import { ChangePasswordForm } from "../../../src/components/ChangePasswordForm";
import { readSession } from "../../../src/lib/session";

export const metadata = { title: "Security" };

export default async function AccountSecurityPage() {
  const session = await readSession();
  const accountId = session?.accountId;

  let hasPassword = false;
  if (accountId) {
    const [account] = await createDb()
      .select({ passwordHash: accounts.passwordHash })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    hasPassword = Boolean(account?.passwordHash);
  }

  return (
    <section className="section-block">
      <div className="content-header compact-header">
        <div>
          <h2>Security</h2>
          <p className="copy">
            Changing your password signs out every other session.
          </p>
        </div>
      </div>
      <section className="card">
        {hasPassword ? (
          <ChangePasswordForm />
        ) : (
          <p className="copy">
            This account signs in without a password (e.g. with Google). To add
            one, use the <a href="/reset">password reset flow</a> — the emailed
            link proves you control the address.
          </p>
        )}
      </section>
    </section>
  );
}
