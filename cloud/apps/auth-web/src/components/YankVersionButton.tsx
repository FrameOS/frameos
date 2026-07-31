"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

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

  async function toggle() {
    setStatus("busy");
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
      setStatus("error");
    }
  }

  return (
    <button
      className="button button--small"
      disabled={status === "busy"}
      onClick={() => void toggle()}
      title="Unpublished versions are skipped by new installs but stay downloadable when requested explicitly"
      type="button"
    >
      {status === "error" ? "Failed — retry" : yanked ? "Republish" : "Unpublish"}
    </button>
  );
}
