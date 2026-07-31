import { cookies } from "next/headers";
import { AuthCard } from "../../src/components/AuthCard";
import { RequestResetForm } from "../../src/components/PasswordResetForms";
import { authCookieNames } from "../../src/lib/auth-cookies";

export const metadata = { title: "Reset password" };

export default async function ResetPage() {
  // Prefilled when the user arrives from the Google-link warning, so
  // finishing the merge is one click instead of retyping the address.
  const cookieStore = await cookies();
  const mergeEmail = cookieStore.get(authCookieNames.mergeEmail)?.value;

  return (
    <AuthCard eyebrow="Reset password" title="Forgot your password?">
      <RequestResetForm initialEmail={mergeEmail ?? ""} />
    </AuthCard>
  );
}
