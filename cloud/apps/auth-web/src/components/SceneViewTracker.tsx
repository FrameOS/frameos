"use client";

import posthog from "posthog-js";
import { useEffect } from "react";

export function SceneViewTracker({
  sceneId,
  visibility,
}: {
  sceneId: string;
  visibility: string;
}) {
  useEffect(() => {
    posthog.capture("scene_viewed", { scene_id: sceneId, visibility });
  }, [sceneId, visibility]);
  return null;
}
