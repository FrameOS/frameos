// The browser half of an AI-proposed frame install. The agent's
// add_scene_to_frame tool never deploys: it emits an InstallProposalEvent
// (src/lib/ai/tools.ts) and the chat renders an Install card from it. This
// module is what the card's Approve button runs — the same owner-only route
// the Scenes tab uses, from the user's own session, with the settings groups
// the card showed. Kept free of Next server imports so it runs in the browser
// and under vitest's node environment alike.

export type AiInstallProposal = {
  type: "proposal";
  kind: "install_scene";
  proposal_id: string;
  frame: { id: string; name: string; connected: boolean; status: string };
  scene: { id: string; name: string; slug: string; version: number | null };
  declared_settings_groups: string[];
  already_assigned: boolean;
};

export type AiInstallProposalStatus =
  | { state: "pending" }
  | { state: "approving" }
  | { state: "installed"; queued: boolean }
  | { state: "failed"; error: string }
  | { state: "dismissed" };

/** Human names for the settings groups a scene can declare. */
export const settingsGroupLabels: Record<string, string> = {
  frameOS: "FrameOS API key",
  github: "GitHub token",
  homeAssistant: "Home Assistant URL and access token",
  immich: "Immich URL and API key",
  openAI: "OpenAI API key",
  unsplash: "Unsplash access key",
};

export function settingsGroupLabel(group: string): string {
  return settingsGroupLabels[group] ?? group;
}

export function isAiInstallProposal(value: unknown): value is AiInstallProposal {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  const frame = record.frame as Record<string, unknown> | undefined;
  const scene = record.scene as Record<string, unknown> | undefined;
  return (
    record.type === "proposal" &&
    record.kind === "install_scene" &&
    typeof record.proposal_id === "string" &&
    !!frame &&
    typeof frame.id === "string" &&
    !!scene &&
    typeof scene.id === "string" &&
    Array.isArray(record.declared_settings_groups)
  );
}

type FrameSceneRow = { scene_id: string; scene_version: number | null };

/**
 * Install the proposed scene: read the frame's current list, append (or
 * re-pin) the scene with the granted settings groups, and POST the whole
 * list back — the endpoint replaces the assignments wholesale and queues the
 * set_scenes push. Throws with the server's error code on refusal.
 */
export async function approveAiInstallProposal(
  proposal: AiInstallProposal,
  { fetchImpl = fetch }: { fetchImpl?: typeof fetch } = {},
): Promise<{ queued: boolean }> {
  const listResponse = await fetchImpl(`/api/frames/${encodeURIComponent(proposal.frame.id)}/scenes`);
  if (!listResponse.ok) {
    throw new Error(await errorCode(listResponse, "Could not read the frame's scenes"));
  }
  const current = ((await listResponse.json()) as { scenes?: FrameSceneRow[] }).scenes ?? [];
  const entry = {
    scene_id: proposal.scene.id,
    ...(proposal.scene.version ? { scene_version: proposal.scene.version } : {}),
    // The grant the card showed: exactly the groups the scene declares.
    settings_groups: proposal.declared_settings_groups,
  };
  const scenes = current.some((row) => row.scene_id === proposal.scene.id)
    ? current.map((row) =>
        row.scene_id === proposal.scene.id
          ? entry
          : {
              scene_id: row.scene_id,
              ...(row.scene_version ? { scene_version: row.scene_version } : {}),
            },
      )
    : [
        ...current.map((row) => ({
          scene_id: row.scene_id,
          ...(row.scene_version ? { scene_version: row.scene_version } : {}),
        })),
        entry,
      ];
  const response = await fetchImpl(`/api/frames/${encodeURIComponent(proposal.frame.id)}/scenes`, {
    body: JSON.stringify({ scenes }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(await errorCode(response, "The install was refused"));
  }
  return { queued: !proposal.frame.connected };
}

async function errorCode(response: Response, fallback: string): Promise<string> {
  const payload = (await response.json().catch(() => ({}))) as { error?: unknown; detail?: unknown };
  if (typeof payload.detail === "string" && payload.detail) {
    return payload.detail;
  }
  if (typeof payload.error === "string" && payload.error) {
    return installErrorMessage(payload.error);
  }
  return `${fallback} (HTTP ${response.status})`;
}

export function installErrorMessage(code: string): string {
  switch (code) {
    case "frame_not_active":
      return "The frame is not active yet — confirm it first.";
    case "scene_not_allowed":
      return "This scene version runs shell commands, which a cloud push may never carry.";
    case "invalid_scene":
      return "The scene is no longer available.";
    case "scene_version_missing":
      return "That version of the scene no longer exists.";
    case "reauth_required":
      return "Sign in again to change this frame.";
    default:
      return `The install was refused (${code}).`;
  }
}
