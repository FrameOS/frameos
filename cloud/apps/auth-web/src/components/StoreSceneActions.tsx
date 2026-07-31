"use client";

import { Eye, EyeOff, Trash2 } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import posthog from "posthog-js";
import { useState } from "react";

// Owner controls for one published scene on the account page: flip
// visibility, delete. Server state is refreshed after each action.
export function StoreSceneActions({
  name,
  sceneId,
  status,
  visibility,
}: {
  name: string;
  sceneId: string;
  status: string;
  visibility: string;
}) {
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

  async function toggleVisibility() {
    const makePublic = visibility !== "public";
    if (
      makePublic &&
      !window.confirm(
        `Make "${name}" public? Anyone will be able to browse and install it from the FrameOS store.`,
      )
    ) {
      return;
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
  }

  async function remove() {
    if (
      !window.confirm(
        `Delete "${name}" from the store? All published versions disappear for everyone. This cannot be undone.`,
      )
    ) {
      return;
    }
    const ok = await call({ method: "DELETE" }, { refresh: false });
    if (ok) {
      posthog.capture("scene_deleted", { scene_id: sceneId });
      if (pathname === "/account/scenes" || pathname === "/scenes") {
        router.refresh();
      } else {
        router.replace("/account/scenes");
      }
    }
  }

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
