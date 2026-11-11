import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AuthCard } from "../../../src/components/AuthCard";
import { ProviderLinkForm } from "../../../src/components/ProviderLinkForm";
import { hasDatabaseUrl } from "../../../src/lib/env";
import { providerLabels } from "../../../src/lib/provider-account";
import {
  pendingLinkCookieName,
  readPendingLinkToken,
} from "../../../src/lib/provider-link";

export const metadata = { title: "Connect sign-in" };

// A Google or Apple sign-in that matched an existing, verified password
// account. The pending cookie (minted by the provider's callback) says which
// account; the visitor proves its password here and POST /api/auth/link does
// the linking. Without the cookie there is nothing to confirm, so back to
// /login.
export default async function LinkProviderPage() {
  const cookieStore = await cookies();
  const pending = await readPendingLinkToken(
    cookieStore.get(pendingLinkCookieName)?.value,
  );
  if (!pending || !hasDatabaseUrl()) {
    redirect("/login?error=link_expired");
  }
  const method = pending.providerKey === "apple" ? "Sign in with Apple" : "Google sign-in";

  return (
    <AuthCard
      copy={`A FrameOS Cloud account with ${pending.email} already exists. Enter its password to connect ${method} to it. From then on either method opens the same account.`}
      eyebrow={`Connect ${providerLabels[pending.providerKey]}`}
      title="Confirm it's your account"
    >
      <ProviderLinkForm method={method} provider={providerLabels[pending.providerKey]} />
    </AuthCard>
  );
}
