import Link from "next/link";
import { PublicShell } from "../../src/components/PublicShell";
import { readSession } from "../../src/lib/session";
import { accountIsSuperadmin } from "../../src/lib/superadmin";

const pages = [
  { href: "/legal/terms", label: "Terms of Service" },
  { href: "/legal/privacy", label: "Privacy Policy" },
  { href: "/legal/imprint", label: "Imprint" },
] as const;

// Public by definition: these pages must be readable before anyone has an
// account, which is the whole point of them. PublicShell renders the same
// chrome signed in or out.
export default async function LegalLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await readSession();
  const isSuperadmin = await accountIsSuperadmin(session?.accountId);

  return (
    <PublicShell
      isSuperadmin={isSuperadmin}
      signedIn={Boolean(session)}
      title="Legal"
    >
      <nav aria-label="Legal documents" className="subnav">
        {pages.map((page) => (
          <Link className="subnav__link" href={page.href} key={page.href}>
            {page.label}
          </Link>
        ))}
      </nav>
      <article className="section-block legal-document">{children}</article>
    </PublicShell>
  );
}
