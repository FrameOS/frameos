import Link from "next/link";
import { getMyScenesUrl, getStoreUrl } from "../lib/env";

// The two views of the scene store, as tabs under the header: the public
// store front (/) and the signed-in owner's private scene list (/my-scenes).
// Signed-out visitors only have the store, so no tabs are drawn for them.
export function StoreTabs({ active }: { active: "store" | "mine" }) {
  const storeUrl = getStoreUrl();
  const tabs = [
    { href: storeUrl, key: "store", label: "Public scene store" },
    { href: getMyScenesUrl(), key: "mine", label: "My scenes" },
  ] as const;
  return (
    <nav aria-label="Scene store sections" className="subnav subnav--store">
      {tabs.map((tab) => (
        <Link
          aria-current={tab.key === active ? "page" : undefined}
          className={
            tab.key === active
              ? "subnav__link subnav__link--active"
              : "subnav__link"
          }
          href={tab.href}
          key={tab.key}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
