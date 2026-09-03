import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AuthCard } from "../../../src/components/AuthCard";
import { GoogleLinkForm } from "../../../src/components/GoogleLinkForm";
import { hasDatabaseUrl } from "../../../src/lib/env";
import {
  pendingGoogleLinkCookieName,
  readPendingGoogleLinkToken,
} from "../../../src/lib/google-link";

export const metadata = { title: "Connect Google sign-in" };

// A Google sign-in that matched an existing, verified password account. The
// pending cookie (minted by the Google callback) says which account; the
// visitor proves its password here and POST /api/auth/google/link does the
// linking. Without the cookie there is nothing to confirm, so back to /login.
export default async function LinkGooglePage() {
  const cookieStore = await cookies();
  const pending = await readPendingGoogleLinkToken(
    cookieStore.get(pendingGoogleLinkCookieName)?.value,
  );
  if (!pending || !hasDatabaseUrl()) {
    redirect("/login?error=google_link_expired");
  }

  return (
    <AuthCard
      copy={`A FrameOS Cloud account with ${pending.email} already exists. Enter its password to connect Google sign-in to it. From then on either method opens the same account.`}
      eyebrow="Connect Google"
      title="Confirm it's your account"
    >
      <GoogleLinkForm />
    </AuthCard>
  );
}
