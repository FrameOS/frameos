"use client";

import { ArrowRightLeft } from "lucide-react";
import { RowMenu } from "./RowMenu";

// The "…" at the right end of the scene store's tabs: the rare actions that
// do not deserve a card on the page. One entry today — the compiled-scene
// converter, which most visitors never need and the few who do can find.
export function StoreTabsMenu({ convertUrl }: { convertUrl: string }) {
  return (
    <RowMenu
      buttonClassName="button button--small button--subtle"
      buttonTestId="store-tabs-menu"
      className="subnav__menu"
      label="More"
      panelClassName="row-menu__panel--wide"
      title="More"
    >
      <a className="row-menu__item row-menu__item--link" href={convertUrl} role="menuitem">
        <ArrowRightLeft aria-hidden size={16} />
        <span>
          <span className="row-menu__label">Convert a legacy compiled scene</span>
          <span className="row-menu__hint">
            Nim code nodes and Nim apps become an interpreted scene that runs without a whole-frame
            recompilation.
          </span>
        </span>
      </a>
    </RowMenu>
  );
}
