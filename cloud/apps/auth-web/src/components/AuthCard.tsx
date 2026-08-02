import { BrandMark } from "./BrandMark";

export function AuthCard({
  children,
  eyebrow,
  title,
  copy,
}: Readonly<{
  children: React.ReactNode;
  eyebrow: string;
  title: string;
  copy?: string;
}>) {
  return (
    <main className="page center-page">
      <section className="auth-card" aria-labelledby="auth-title">
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
    </main>
  );
}
