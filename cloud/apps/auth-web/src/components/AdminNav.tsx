"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const sections = [
  { href: "/admin", key: "overview", label: "Overview" },
  { href: "/admin/users", key: "users", label: "Users" },
  { href: "/admin/backends", key: "backends", label: "Backends" },
  { href: "/admin/frames", key: "frames", label: "Frames" },
  { href: "/admin/scenes", key: "scenes", label: "Store scenes" },
  { href: "/admin/reports", key: "reports", label: "Reports" },
  { href: "/admin/billing", key: "billing", label: "Billing" },
] as const;

export type AdminNavCounts = Partial<
  Record<(typeof sections)[number]["key"], number>
>;

// The stable tab bar every /admin page shows, mirroring AccountNav.
export function AdminNav({ counts }: { counts?: AdminNavCounts }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Admin sections" className="subnav">
      {sections.map((section) => {
        const count = counts?.[section.key];
        return (
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
            {count !== undefined ? (
              <span className="subnav__count">{count}</span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
