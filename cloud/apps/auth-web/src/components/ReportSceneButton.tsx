"use client";

import posthog from "posthog-js";
import { useState } from "react";

export function ReportSceneButton({
  sceneId,
  signedIn,
}: {
  sceneId: string;
  signedIn: boolean;
}) {
  const [status, setStatus] = useState<
    "idle" | "busy" | "done" | "already" | "error"
  >("idle");

  async function report() {
    if (!signedIn) {
      window.location.href = "/login";
      return;
    }
    const reason = window.prompt(
      "What is wrong with this scene? Your report goes to the FrameOS Cloud moderators.",
    );
    if (!reason?.trim()) {
      return;
    }
    setStatus("busy");
    const response = await fetch(`/api/store/scenes/${sceneId}/report`, {
      body: JSON.stringify({ reason: reason.trim() }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!response.ok) {
      setStatus("error");
      return;
    }
    const payload = (await response.json()) as { status?: string };
    const nextStatus = payload.status === "already_reported" ? "already" : "done";
    if (nextStatus === "done") {
      posthog.capture("scene_reported", { scene_id: sceneId });
    }
    setStatus(nextStatus);
  }

  if (status === "done") {
    return <span className="pill pill-ok">Reported — thank you</span>;
  }
  if (status === "already") {
    return <span className="pill">Already reported</span>;
  }

  return (
    <button
      className="button button--subtle"
      disabled={status === "busy"}
      onClick={() => void report()}
      title="Flag this scene for the moderators"
      type="button"
    >
      {status === "error" ? "Failed — retry" : "Report scene"}
    </button>
  );
}
