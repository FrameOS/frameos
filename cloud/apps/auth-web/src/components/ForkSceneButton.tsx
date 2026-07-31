"use client";

import { GitFork } from "lucide-react";
import posthog from "posthog-js";
import { useState } from "react";

// Page-level fork: copy this scene (latest published version, unedited) as a
// new private scene under the caller's account. The editor modal offers the
// same endpoint for forking *edited* scenes; this button is the one-click
// "save a copy to my account" path.
export function ForkSceneButton({
  sceneId,
  signedIn,
}: {
  sceneId: string;
  signedIn: boolean;
}) {
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");

  async function fork() {
    if (!signedIn) {
      window.location.href = "/login";
      return;
    }
    setState("busy");
    try {
      const scenesResponse = await fetch(
        `/api/store/scenes/${sceneId}/scenes.json`,
      );
      if (!scenesResponse.ok) {
        setState("error");
        return;
      }
      const scenes = (await scenesResponse.json()) as unknown[];
      const response = await fetch(`/api/account/scenes/${sceneId}/fork`, {
        body: JSON.stringify({ scenes }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.scene?.slug) {
        setState("error");
        return;
      }
      posthog.capture("scene_forked", { source_scene_id: sceneId });
      window.location.href = `/s/${payload.scene.slug}`;
    } catch {
      setState("error");
    }
  }

  return (
    <button
      className="button button--subtle"
      disabled={state === "busy"}
      onClick={() => void fork()}
      title="Save a copy of this scene as a new private scene in your account"
      type="button"
    >
      <GitFork aria-hidden size={18} />
      {state === "busy" ? "Forking…" : state === "error" ? "Fork failed — retry" : "Fork"}
    </button>
  );
}
