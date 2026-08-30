"use client";

import { ArrowRightLeft, MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";

// The "…" at the right end of the scene store's tabs: the rare actions that
// do not deserve a card on the page. One entry today — the compiled-scene
// converter, which most visitors never need and the few who do can find.
export function StoreTabsMenu({ convertUrl }: { convertUrl: string }) {
  const [open, setOpen] = useState(false);
  const [panelPosition, setPanelPosition] = useState({ right: 0, top: 0 });
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div className="row-menu subnav__menu" ref={containerRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        className="button button--small button--subtle"
        data-testid="store-tabs-menu"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setPanelPosition({ right: window.innerWidth - rect.right, top: rect.bottom + 4 });
          setOpen((value) => !value);
        }}
        title="More"
        type="button"
      >
        <MoreHorizontal aria-hidden size={16} />
      </button>
      {open ? (
        <div className="row-menu__panel row-menu__panel--wide" role="menu" style={{ right: panelPosition.right, top: panelPosition.top }}>
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
        </div>
      ) : null}
    </div>
  );
}
