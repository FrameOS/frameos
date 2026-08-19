import { eq } from "drizzle-orm";
import { Download } from "lucide-react";
import { accounts, createDb } from "@frameos-cloud/db";
import { ChangePasswordForm } from "../../../src/components/ChangePasswordForm";
import { DeleteAccountForm } from "../../../src/components/DeleteAccountForm";
import {
  TwoFactorSettings,
  type TwoFactorStatusPayload,
} from "../../../src/components/TwoFactorSettings";
import { twoFactorStatusPayload } from "../../../src/lib/account-security";
import { readSession } from "../../../src/lib/session";

export const metadata = { title: "Security" };

export default async function AccountSecurityPage() {
  const session = await readSession();
  const accountId = session?.accountId;

  let hasPassword = false;
  let isSuperadmin = false;
  let primaryEmail: string | undefined;
  let twoFactor: TwoFactorStatusPayload | undefined;
  if (accountId) {
    const [account] = await createDb()
      .select({
        isSuperadmin: accounts.isSuperadmin,
        passwordHash: accounts.passwordHash,
        primaryEmail: accounts.primaryEmail,
      })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    hasPassword = Boolean(account?.passwordHash);
    isSuperadmin = Boolean(account?.isSuperadmin);
    primaryEmail = account?.primaryEmail ?? undefined;
    twoFactor = await twoFactorStatusPayload(createDb(), accountId, hasPassword);
  }

  return (
    <>
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
              This account signs in without a password (e.g. with Google). To
              add one, use the <a href="/reset">password reset flow</a> — the
              emailed link proves you control the address.
            </p>
          )}
        </section>
      </section>

      <section className="section-block">
        <div className="content-header compact-header">
          <div>
            <h2>Two-factor authentication</h2>
            <p className="copy">
              Optional, and recommended for an account that controls physical
              frames: add an authenticator app or a passkey and sign-in asks
              for it after your password or Google.
            </p>
          </div>
        </div>
        <section className="card">
          {twoFactor ? <TwoFactorSettings initial={twoFactor} /> : null}
        </section>
      </section>

      {/* GDPR arts. 15/17/20 in two buttons. Both are deliberately here on the
          security page rather than buried in a support email: a right you have
          to ask a human for is a right with a queue in front of it. */}
      <section className="section-block">
        <div className="content-header compact-header">
          <div>
            <h2>Your data</h2>
            <p className="copy">
              Take a copy of everything on this account, or close it for good.
              What we store and why is in our{" "}
              <a href="/legal/privacy">Privacy Policy</a>.
            </p>
          </div>
        </div>
        <section className="card">
          <h3>Export</h3>
          <p className="copy">
            Downloads a JSON file with your account, frames, scenes, settings,
            chats and security history. Binary files (scene zips, images,
            backups) are listed with a download link rather than embedded.
          </p>
          <div className="actions">
            <a className="button" download href="/api/account/export">
              <Download aria-hidden size={18} />
              Download my data
            </a>
          </div>
        </section>
      </section>

      <section className="section-block">
        <div className="content-header compact-header">
          <div>
            <h2>Delete account</h2>
            <p className="copy">
              Permanent, immediate, and entirely up to you — no support ticket
              involved.
            </p>
          </div>
        </div>
        <section className="card">
          <DeleteAccountForm
            hasPassword={hasPassword}
            isSuperadmin={isSuperadmin}
            primaryEmail={primaryEmail}
          />
        </section>
      </section>
    </>
  );
}
