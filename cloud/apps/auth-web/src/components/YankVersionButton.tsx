"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ownerActionErrorMessage } from "./ownerActionError";

export function YankVersionButton({
  sceneId,
  version,
  yanked,
}: {
  sceneId: string;
  version: number;
  yanked: boolean;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "busy" | "error">("idle");
  // The server's reason ("scene pulled", "must keep one version"), not a
  // bare "Failed" that reads as a bug.
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setStatus("busy");
    setError(null);
    const response = await fetch(
      `/api/account/scenes/${sceneId}/versions/${version}`,
      {
        body: JSON.stringify({ yanked: !yanked }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
    );

    if (response.ok) {
      router.refresh();
      setStatus("idle");
    } else {
      const detail = await response.json().catch(() => ({}));
      setError(
        ownerActionErrorMessage(
          detail,
          response.status,
          yanked ? "Republishing failed" : "Unpublishing failed",
        ),
      );
      setStatus("error");
    }
  }

  return (
    <>
      <button
        className="button button--small"
        disabled={status === "busy"}
        onClick={() => void toggle()}
        title="Unpublished versions are skipped by new installs but stay downloadable when requested explicitly"
        type="button"
      >
        {status === "error" ? "Retry" : yanked ? "Republish" : "Unpublish"}
      </button>
      {error ? (
        <span className="pill pill-warning" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}
