import { redirect } from "next/navigation";
import { AppSignInForm } from "../../../src/components/AppSignInForm";
import { AuthCard } from "../../../src/components/AuthCard";
import { verifyAppSignInRequestToken } from "../../../src/lib/app-sign-in";
import { readSession } from "../../../src/lib/session";

export const metadata = { title: "Sign in to the FrameOS app" };

type AppSignInPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

// The app's sign-in sheet found this browser already signed in (from before
// the app asked): ask before handing the session on (src/lib/app-sign-in.ts).
// Rendering spends nothing; only the button's POST mints a code.
export default async function AppSignInPage({ searchParams }: AppSignInPageProps) {
  const params = searchParams ? await searchParams : {};
  const raw = Array.isArray(params.request) ? params.request[0] : params.request;
  const request = raw?.trim() ?? "";
  const valid = request ? await verifyAppSignInRequestToken(request) : undefined;

  if (!valid) {
    return (
      <AuthCard
        inApp
        copy="This sign-in took too long. Go back to the app and start again."
        eyebrow="FrameOS app"
        title="Start again in the app"
      >
        {null}
      </AuthCard>
    );
  }

  const session = await readSession();
  if (!session?.accountId || session.apiToken) {
    redirect(`/api/auth/app/authorize?request=${encodeURIComponent(request)}`);
  }

  return (
    <AuthCard
      inApp
      copy="The FrameOS app on this device asks to sign in with the account this browser is signed in to. Continue only if you started this from the app."
      eyebrow="FrameOS app"
      title="Sign in to the app?"
    >
      <AppSignInForm email={session.email} request={request} />
    </AuthCard>
  );
}
