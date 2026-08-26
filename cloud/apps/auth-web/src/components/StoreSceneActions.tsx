"use client";

import { Eye, EyeOff, MoreHorizontal, Trash2 } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import posthog from "posthog-js";
import { useEffect, useRef, useState } from "react";

// env.ts's myScenesPath, repeated here so this client component does not pull
// the server-side env module into the browser bundle.
const myScenesPath = "/my-scenes";

// What an owner action came to: the request went through, the owner
// backed out of the confirm dialog, or the server refused it (with `error`
// set for display).
type ActionOutcome = "done" | "cancelled" | "failed";

type StoreSceneActionsProps = {
  name: string;
  sceneId: string;
  // "active" | "pulled": a pulled scene cannot change visibility.
  status: string;
  visibility: string;
};

// The owner operations on one published scene — flip visibility, delete —
// shared by the table's button row and the grid card's "..." menu. Server
// state is refreshed after each action.
function useStoreSceneActions({
  name,
  sceneId,
  visibility,
}: Omit<StoreSceneActionsProps, "status">) {
  const router = useRouter();
  const pathname = usePathname();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(
    init: RequestInit,
    { refresh = true }: { refresh?: boolean } = {},
  ): Promise<boolean> {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/account/scenes/${sceneId}`, {
      headers: { "content-type": "application/json" },
      ...init,
    });
    if (response.ok && refresh) {
      router.refresh();
    } else {
      let detail: Record<string, unknown> = {};
      try {
        detail = await response.json();
      } catch {
        // no JSON body; the generic message below covers it
      }
      if (detail.error === "content_rejected") {
        const categories = Array.isArray(detail.categories)
          ? ` (${detail.categories.join(", ")})`
          : "";
        setError(`Rejected by content moderation${categories}`);
      } else if (detail.error === "moderation_unavailable") {
        setError("Moderation service unavailable — try again later");
      } else {
        setError("Failed");
      }
    }
    setBusy(false);
    return response.ok;
  }

  async function toggleVisibility(): Promise<ActionOutcome> {
    const makePublic = visibility !== "public";
    if (
      makePublic &&
      !window.confirm(
        `Make "${name}" public? Anyone will be able to browse and install it from the FrameOS store.`,
      )
    ) {
      return "cancelled";
    }
    const ok = await call({
      body: JSON.stringify({ visibility: makePublic ? "public" : "private" }),
      method: "PATCH",
    });
    if (ok) {
      posthog.capture("scene_visibility_changed", {
        new_visibility: makePublic ? "public" : "private",
        scene_id: sceneId,
      });
    }
    return ok ? "done" : "failed";
  }

  async function remove(): Promise<ActionOutcome> {
    if (
      !window.confirm(
        `Delete "${name}" from the store? All published versions disappear for everyone. This cannot be undone.`,
      )
    ) {
      return "cancelled";
    }
    const ok = await call({ method: "DELETE" }, { refresh: false });
    if (ok) {
      posthog.capture("scene_deleted", { scene_id: sceneId });
      if (pathname === myScenesPath) {
        router.refresh();
      } else {
        router.replace(myScenesPath);
      }
    }
    return ok ? "done" : "failed";
  }

  return { busy, error, remove, toggleVisibility };
}

// Owner controls for one published scene as a row of buttons (the account
// table, the scene page).
export function StoreSceneActions({
  name,
  sceneId,
  status,
  visibility,
}: StoreSceneActionsProps) {
  const { busy, error, remove, toggleVisibility } = useStoreSceneActions({
    name,
    sceneId,
    visibility,
  });

  return (
    <div className="inline-actions">
      {status === "pulled" ? null : (
        <button
          className="button button--small"
          disabled={busy}
          onClick={() => void toggleVisibility()}
          type="button"
        >
          {visibility === "public" ? (
            <EyeOff aria-hidden size={16} />
          ) : (
            <Eye aria-hidden size={16} />
          )}
          {visibility === "public" ? "Make private" : "Make public"}
        </button>
      )}
      <button
        className="button button--small button-danger"
        disabled={busy}
        onClick={() => void remove()}
        type="button"
      >
        <Trash2 aria-hidden size={16} />
        Delete
      </button>
      {error ? <span className="pill pill-warning">{error}</span> : null}
    </div>
  );
}

// The same owner controls folded into a "..." menu, for the scene grid where
// a card has no room for a button row. The panel is fixed-positioned so it
// escapes any overflow clipping around the card.
export function StoreSceneMenu({
  name,
  sceneId,
  status,
  visibility,
}: StoreSceneActionsProps) {
  const { busy, error, remove, toggleVisibility } = useStoreSceneActions({
    name,
    sceneId,
    visibility,
  });
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

  // The menu stays open while a request runs (its items are disabled) and
  // after a refusal, so the error pill has somewhere to live; it closes when
  // the action went through or the owner backed out of the confirm.
  async function run(action: () => Promise<ActionOutcome>) {
    if ((await action()) !== "failed") {
      setOpen(false);
    }
  }

  return (
    <div className="row-menu" ref={containerRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`More actions for ${name}`}
        className="scene-card__menu-button"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setPanelPosition({
            right: window.innerWidth - rect.right,
            top: rect.bottom + 4,
          });
          setOpen((value) => !value);
        }}
        title="More actions"
        type="button"
      >
        <MoreHorizontal aria-hidden size={16} />
      </button>
      {open ? (
        <div
          className="row-menu__panel"
          role="menu"
          style={{ right: panelPosition.right, top: panelPosition.top }}
        >
          {status === "pulled" ? null : (
            <button
              className="row-menu__item"
              disabled={busy}
              onClick={() => void run(toggleVisibility)}
              role="menuitem"
              type="button"
            >
              {visibility === "public" ? (
                <EyeOff aria-hidden size={16} />
              ) : (
                <Eye aria-hidden size={16} />
              )}
              {visibility === "public" ? "Make private" : "Make public"}
            </button>
          )}
          <button
            className="row-menu__item row-menu__item--danger"
            disabled={busy}
            onClick={() => void run(remove)}
            role="menuitem"
            type="button"
          >
            <Trash2 aria-hidden size={16} />
            Delete
          </button>
          {error ? (
            <span className="row-menu__error pill pill-warning">{error}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
