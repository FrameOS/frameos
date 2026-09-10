"use client";

import { Eye, EyeOff, MoreHorizontal, Trash2, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import posthog from "posthog-js";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ownerActionErrorMessage } from "./ownerActionError";

// env.ts's myScenesPath, repeated here so this client component does not pull
// the server-side env module into the browser bundle.
const myScenesPath = "/my-scenes";

// What an owner action came to: the request went through, the owner
// backed out of the confirm dialog, the server refused it (with `error`
// set for display), or it handed off to a dialog of its own.
type ActionOutcome = "done" | "cancelled" | "failed" | "pending";

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
      setError(ownerActionErrorMessage(detail, response.status));
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

  // Deleting is the one owner action that is not undoable — versions are
  // immutable and a broken one is yanked, not deleted — so it gets a real
  // dialog that spells out what goes and asks for the scene's name, not a
  // browser confirm the finger clicks through.
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  function remove(): Promise<ActionOutcome> {
    setError(null);
    setConfirmingDelete(true);
    return Promise.resolve("pending");
  }

  async function confirmDelete(): Promise<void> {
    const ok = await call({ method: "DELETE" }, { refresh: false });
    if (ok) {
      posthog.capture("scene_deleted", { scene_id: sceneId });
      setConfirmingDelete(false);
      if (pathname === myScenesPath) {
        router.refresh();
      } else {
        router.replace(myScenesPath);
      }
    }
  }

  const deleteDialog = confirmingDelete ? (
    <DeleteSceneDialog
      busy={busy}
      error={error}
      name={name}
      onCancel={() => {
        setConfirmingDelete(false);
        setError(null);
      }}
      onConfirm={() => void confirmDelete()}
    />
  ) : null;

  return { busy, deleteDialog, error, remove, toggleVisibility };
}

type DeleteSceneDialogProps = {
  busy: boolean;
  error: string | null;
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
};

export function DeleteSceneDialog({
  busy,
  error,
  name,
  onCancel,
  onConfirm,
}: DeleteSceneDialogProps) {
  const [typed, setTyped] = useState("");
  const matches = typed.trim() === name.trim();
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCancelRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return createPortal(
    <div
      aria-label={`Delete ${name}`}
      aria-modal
      className="dialog"
      onClick={onCancel}
      role="dialog"
    >
      <div className="dialog__panel" onClick={(event) => event.stopPropagation()}>
        <div className="dialog__head">
          <h2>Delete {name}?</h2>
          <button
            aria-label="Close"
            className="dialog__close"
            onClick={onCancel}
            type="button"
          >
            <X aria-hidden size={18} />
          </button>
        </div>
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (matches && !busy) {
              onConfirm();
            }
          }}
        >
          <p className="copy">
            Every published version of this scene disappears from the store
            for everyone, along with its page, its share links and its version
            history. Frames that installed it keep the copy they have but stop
            receiving updates. This cannot be undone — to retire one bad
            version and keep the rest, yank that version instead.
          </p>
          <div className="field">
            <label htmlFor="delete-scene-name">
              Type <strong>{name}</strong> to confirm
            </label>
            <input
              autoComplete="off"
              autoFocus
              className="input"
              disabled={busy}
              id="delete-scene-name"
              onChange={(event) => setTyped(event.target.value)}
              placeholder={name}
              type="text"
              value={typed}
            />
          </div>
          {error ? <p className="pill pill-warning">{error}</p> : null}
          <div className="button-row">
            <button
              className="button button-danger"
              disabled={!matches || busy}
              type="submit"
            >
              <Trash2 aria-hidden size={16} />
              {busy ? "Deleting…" : "Delete scene"}
            </button>
            <button
              className="button button--subtle"
              disabled={busy}
              onClick={onCancel}
              type="button"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

// Owner controls for one published scene as a row of buttons (the account
// table, the scene page).
export function StoreSceneActions({
  name,
  sceneId,
  status,
  visibility,
}: StoreSceneActionsProps) {
  const { busy, deleteDialog, error, remove, toggleVisibility } =
    useStoreSceneActions({
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
      {error && !deleteDialog ? (
        <span className="pill pill-warning">{error}</span>
      ) : null}
      {deleteDialog}
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
  const { busy, deleteDialog, error, remove, toggleVisibility } =
    useStoreSceneActions({
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
  // the action went through, the owner backed out of the confirm, or a
  // dialog of its own took over (delete).
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
      {deleteDialog}
    </div>
  );
}
