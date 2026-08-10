import { AuthCard } from "../../src/components/AuthCard";
import { ConfirmResetForm } from "../../src/components/PasswordResetForms";

export const metadata = { title: "Set a new password" };

type RecoveryPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function RecoveryPage({
  searchParams,
}: RecoveryPageProps) {
  const params = searchParams ? await searchParams : {};
  const rawToken = Array.isArray(params.token) ? params.token[0] : params.token;
  const token = rawToken?.trim();

  return (
    <AuthCard
      copy={
        token
          ? "Choose a new password for your FrameOS Cloud account."
          : "This page finishes a password reset. Open it through the link in your reset email."
      }
      eyebrow="Account recovery"
      title={token ? "Set a new password" : "Missing reset link"}
    >
      {token ? (
        <ConfirmResetForm token={token} />
      ) : (
        <div className="actions">
          <a className="button button-primary" href="/reset">
            Request a reset link
          </a>
        </div>
      )}
    </AuthCard>
  );
}
