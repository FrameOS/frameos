"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// The four views of the books, in the order somebody actually reads them:
// the totals, then the entries behind a total, then the chart those entries
// name, then one customer's own history.
const sections = [
  { href: "/admin/billing", label: "Trial balance" },
  { href: "/admin/billing/journal", label: "Journal" },
  { href: "/admin/billing/accounts", label: "Chart of accounts" },
  { href: "/admin/billing/customers", label: "Customer statement" },
] as const;

export function BillingNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Billing views" className="subnav">
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
