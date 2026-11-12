import { BrandMark } from "./BrandMark";
import { LegalFooter } from "./LegalFooter";

export function AuthCard({
  children,
  eyebrow,
  title,
  copy,
  inApp = false,
}: Readonly<{
  children: React.ReactNode;
  eyebrow: string;
  title: string;
  copy?: string;
  /** Shown in the iOS app's sign-in sheet: no price list (LegalFooter). */
  inApp?: boolean;
}>) {
  return (
    <main className="page center-page">
      {/* ph-no-capture: every card that uses this shell is an email/password
          form or a token-bearing link landing (/verify-email, /recovery), so
          nothing here should reach autocapture. The deliberate
          user_logged_in / user_signed_up / google_sign_in_started events are
          explicit captures and still fire. */}
      <section className="auth-card ph-no-capture" aria-labelledby="auth-title">
        <div className="auth-card__body">
          <BrandMark />
          <p className="eyebrow">{eyebrow}</p>
          <h1 className="title" id="auth-title">
            {title}
          </h1>
          {copy ? <p className="copy">{copy}</p> : null}
          {children}
        </div>
      </section>
      <LegalFooter hidePricing={inApp} />
    </main>
  );
}
