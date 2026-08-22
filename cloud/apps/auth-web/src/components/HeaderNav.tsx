"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { activeHeaderSection, type HeaderNavSection } from "../lib/header-nav";

export type HeaderNavLink = {
  href: string;
  label: string;
  section: HeaderNavSection;
};

// The primary nav of the shared cloud header (cloud-chrome.css). Marks the
// entry for the current section (aria-current + a filled pill) and, below
// 40rem, folds the links into a panel behind a hamburger. The /frames SPA
// renders the same markup in cloud-frontend AccountHeader.tsx.
//
// Active detection is by pathname only: the account and store apps may live
// on different origins, but the path prefixes do not collide (/frames,
// /account, /admin — everything else is the store).
export function HeaderNav({
  links,
  logoutUrl,
  signInUrl,
}: {
  links: HeaderNavLink[];
  // Exactly one of these renders as the trailing action.
  logoutUrl?: string;
  signInUrl?: string;
}) {
  const pathname = usePathname();
  const active = activeHeaderSection(pathname);
  const [open, setOpen] = useState(false);

  // A client-side navigation closes the panel.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <>
      <button
        aria-controls="frameos-primary-nav"
        aria-expanded={open}
        aria-label={open ? "Close menu" : "Open menu"}
        className="frameos-account-header__toggle"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {open ? <X aria-hidden /> : <Menu aria-hidden />}
      </button>
      <nav
        aria-label="Primary"
        className={
          open
            ? "frameos-account-header__nav frameos-account-header__nav--open"
            : "frameos-account-header__nav"
        }
        id="frameos-primary-nav"
      >
        {links.map((link) => (
          <Link
            aria-current={active === link.section ? "page" : undefined}
            className={
              active === link.section
                ? "frameos-account-header__link frameos-account-header__link--active"
                : "frameos-account-header__link"
            }
            href={link.href}
            key={link.section}
          >
            {link.label}
          </Link>
        ))}
        {logoutUrl ? (
          <form action={logoutUrl} method="post">
            <button className="frameos-account-header__link" type="submit">
              Sign out
            </button>
          </form>
        ) : null}
        {signInUrl ? (
          <Link className="frameos-account-header__link" href={signInUrl}>
            Sign in
          </Link>
        ) : null}
      </nav>
    </>
  );
}
