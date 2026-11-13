import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createDb } from "@frameos-cloud/db";
import { AuthCard } from "../../../src/components/AuthCard";
import { ProviderLinkForm } from "../../../src/components/ProviderLinkForm";
import { hasDatabaseUrl } from "../../../src/lib/env";
import { providerLabels } from "../../../src/lib/provider-account";
import {
  linkConfirmMethods,
  linkConfirmSentence,
  otherSignInWays,
  pendingLinkCookieName,
  readPendingLinkToken,
} from "../../../src/lib/provider-link";
import { hasRecentAuth, reauthPath } from "../../../src/lib/recent-auth";
import { readSession } from "../../../src/lib/session";

export const metadata = { title: "Connect sign-in" };

const here = "/login/link";

// A Google or Apple sign-in that matched an existing account. The pending
// cookie (minted by the provider's callback) says which account; the visitor
// proves it, and POST /api/auth/link does the linking. The proof is the
// account's password, or a fresh sign-in to it any way it has: the sign-in
// page (or "Confirm it's you" for a session that is too old) comes back here,
// and the page then offers one button. Without the cookie there is nothing to
// confirm, so back to /login.
export default async function LinkProviderPage() {
  const cookieStore = await cookies();
  const pending = await readPendingLinkToken(
    cookieStore.get(pendingLinkCookieName)?.value,
  );
  if (!pending || !hasDatabaseUrl()) {
    redirect("/login?error=link_expired");
  }
  const db = createDb();
  const methods = await linkConfirmMethods(db, pending.accountId, pending.providerKey);
  const method = pending.providerKey === "apple" ? "Sign in with Apple" : "Google sign-in";
  const provider = providerLabels[pending.providerKey];
  const eyebrow = `Connect ${provider}`;

  const session = await readSession();
  const signedIn = session?.accountId && !session.apiToken ? session : undefined;

  if (signedIn?.accountId === pending.accountId) {
    if (await hasRecentAuth(db)) {
      return (
        <AuthCard
          copy={`You are signed in as ${signedIn.email ?? pending.email}. Connect ${method} to this account? From then on either method opens it.`}
          eyebrow={eyebrow}
          title="Connect to your account"
        >
          <ProviderLinkForm method={method} mode="session" provider={provider} />
        </AuthCard>
      );
    }
    return (
      <AuthCard
        copy={`You are signed in as ${signedIn.email ?? pending.email}. Confirm it's you once more to connect ${method} to this account.`}
        eyebrow={eyebrow}
        title="Confirm it's you"
      >
        <div className="actions">
          <a
            className="button button-primary"
            href={`${reauthPath}?return_to=${encodeURIComponent(here)}`}
          >
            Confirm it's you
          </a>
          <a className="button" href="/login">
            Cancel
          </a>
        </div>
      </AuthCard>
    );
  }

  if (signedIn) {
    return (
      <AuthCard
        copy={`This browser is signed in as ${signedIn.email ?? "another account"}. To connect ${method} to the account with ${pending.email}, sign out and sign in to that account.`}
        eyebrow={eyebrow}
        title="Another account is signed in"
      >
        <ProviderLinkForm method={method} mode="switch" provider={provider} />
      </AuthCard>
    );
  }

  return (
    <AuthCard
      copy={`${linkConfirmSentence(pending.email, method, methods)} From then on either method opens the same account.`}
      eyebrow={eyebrow}
      title="Confirm it's your account"
    >
      <ProviderLinkForm
        method={method}
        mode={methods.password ? "password" : "sign_in"}
        otherWays={otherSignInWays(methods)}
        provider={provider}
      />
    </AuthCard>
  );
}
