import { redirect } from "next/navigation";
import { createDb } from "@frameos-cloud/db";
import { AuthCard } from "../../../src/components/AuthCard";
import { ReauthForm } from "../../../src/components/ReauthForm";
import { safeAuthReturnPath } from "../../../src/lib/auth-cookies";
import { getAccountUrl, hasDatabaseUrl, hasGoogleOAuth } from "../../../src/lib/env";
import { hasRecentAuth, reauthMethods } from "../../../src/lib/recent-auth";
import { readSession } from "../../../src/lib/session";

export const metadata = { title: "Confirm it's you" };

type ReauthPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

// "Sudo mode": a sensitive route answered 403 reauth_required, or a page that
// leads to one sent the user here first. The session stays; the user proves
// the credentials once more and goes back to where they were.
export default async function ReauthPage({ searchParams }: ReauthPageProps) {
  const params = searchParams ? await searchParams : {};
  const rawReturnTo = Array.isArray(params.return_to)
    ? params.return_to[0]
    : params.return_to;
  const returnTo = safeAuthReturnPath(rawReturnTo) ?? getAccountUrl();

  const session = await readSession();
  if (!session?.accountId || !hasDatabaseUrl()) {
    redirect(`/login?return_to=${encodeURIComponent(returnTo)}`);
  }
  const db = createDb();
  if (await hasRecentAuth(db)) {
    redirect(returnTo);
  }
  const methods = await reauthMethods(db, session.accountId);

  return (
    <AuthCard
      copy="You are signed in, but this action needs a fresh check of your credentials."
      eyebrow="Confirm it's you"
      title="Verify to continue"
    >
      <ReauthForm
        email={session.email}
        googleEnabled={hasGoogleOAuth()}
        methods={methods}
        returnTo={returnTo}
      />
    </AuthCard>
  );
}
