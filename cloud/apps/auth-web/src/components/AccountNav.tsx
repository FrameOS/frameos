"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const sections = [
  { href: "/account/frames", key: "frames", label: "My frames" },
  { href: "/account/scenes", key: "scenes", label: "My scenes" },
  { href: "/account/installs", key: "installs", label: "Backends" },
  { href: "/account/backups", key: "backups", label: "Backups" },
  { href: "/account/activity", key: "activity", label: "Activity" },
  { href: "/account/security", key: "security", label: "Security" },
] as const;

export function AccountNav({
  counts,
  hrefs,
}: {
  /** Headline numbers per section, shown as a badge behind the tab label. */
  counts?: Partial<Record<(typeof sections)[number]["key"], number>>;
  hrefs?: Partial<Record<(typeof sections)[number]["key"], string>>;
}) {
  const pathname = usePathname();
  return (
    <nav aria-label="Account sections" className="subnav">
      {sections.map((section) => {
        const count = counts?.[section.key];
        const href = hrefs?.[section.key] ?? section.href;
        const canonicalPath = new URL(href, "http://frameos.local").pathname;
        const isActive =
          pathname === section.href || pathname === canonicalPath;
        return (
          <Link
            className={
              isActive ? "subnav__link subnav__link--active" : "subnav__link"
            }
            href={href}
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
