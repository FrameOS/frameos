"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const sections = [
  { href: "/admin", label: "Users" },
  { href: "/admin/scenes", label: "Store scenes" },
  { href: "/admin/reports", label: "Reports" },
];

// The stable tab bar every /admin page shows, mirroring AccountNav.
export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Admin sections" className="subnav">
      {sections.map((section) => (
        <Link
          className={
            pathname === section.href
              ? "subnav__link subnav__link--active"
              : "subnav__link"
          }
          href={section.href}
          key={section.href}
        >
          {section.label}
        </Link>
      ))}
    </nav>
  );
}
