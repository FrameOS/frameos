import Link from "next/link";
import { getMyScenesUrl, getNimConverterUrl, getStoreUrl } from "../lib/env";
import { StoreTabsMenu } from "./StoreTabsMenu";

// The two views of the scene store, as tabs under the header: the public
// store front (/) and the signed-in owner's private scene list (/my-scenes).
// Signed-out visitors only have the store, so no tabs are drawn for them.
// The "…" at the right end holds the rare actions (the compiled-scene
// converter) that do not earn a card on the page.
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
      <StoreTabsMenu convertUrl={getNimConverterUrl()} />
    </nav>
  );
}
