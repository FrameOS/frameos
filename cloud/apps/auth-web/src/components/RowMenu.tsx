"use client";

import { MoreHorizontal } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

// The one "…" menu: a button and the panel it opens. Every per-row menu (the
// installs table, the admin users table, a store-scene card, the store tabs)
// is this component, so the open/close rules live in one place:
//
// - the panel is position:fixed, so it escapes the overflow clipping of the
//   table or card it sits in (coordinates taken from the button on open);
// - it closes on a pointerdown outside the menu and on Escape;
// - those two window listeners exist only while a panel is open. A table of
//   two hundred rows has at most one listener pair at any time, never one per
//   row — closed rows cost nothing but their state.
export function RowMenu({
  buttonClassName = "button button--small",
  buttonTestId,
  children,
  className,
  disabled = false,
  footer,
  label = "More actions",
  panelClassName,
  title = "More actions",
}: {
  buttonClassName?: string;
  buttonTestId?: string;
  // The panel's contents; a function form gets `close` for items that
  // decide themselves whether the menu stays open (an error pill to show).
  children: ReactNode | ((close: () => void) => ReactNode);
  className?: string;
  disabled?: boolean;
  // Rendered inside the menu's container but outside the panel — a dialog an
  // item opened, which must not count as an "outside" click while it shows.
  footer?: ReactNode;
  // aria-label for the button; say what the actions are for ("More actions
  // for alice@example.com").
  label?: string;
  panelClassName?: string;
  title?: string;
}) {
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
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div
      className={className ? `row-menu ${className}` : "row-menu"}
      ref={containerRef}
    >
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={label}
        className={buttonClassName}
        data-testid={buttonTestId}
        disabled={disabled}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setPanelPosition({
            right: window.innerWidth - rect.right,
            top: rect.bottom + 4,
          });
          setOpen((value) => !value);
        }}
        title={title}
        type="button"
      >
        <MoreHorizontal aria-hidden size={16} />
      </button>
      {open ? (
        <div
          className={
            panelClassName ? `row-menu__panel ${panelClassName}` : "row-menu__panel"
          }
          role="menu"
          style={{ right: panelPosition.right, top: panelPosition.top }}
        >
          {typeof children === "function" ? children(close) : children}
        </div>
      ) : null}
      {footer}
    </div>
  );
}
