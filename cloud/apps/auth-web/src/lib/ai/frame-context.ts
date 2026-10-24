// The frame a chat is about, as the model's first message: its id, name,
// panel, memory ceiling and the scenes assigned to it. The chat route
// (app/api/ai/chat) and the voice route (app/api/frames/[frameId]/voice) send
// the same block, so a spoken "switch to the calendar" names the same scene
// the typed one does.
import { asc, eq } from "drizzle-orm";
import { createDb, frameSceneAssignments, storeScenes } from "@frameos-cloud/db";
import { frameForAccount } from "../frames";
import { maxRenderDimension, maxRenderPixels, minRenderDimension } from "../scene-render";
import { frameRenderDevice, type RenderDevice } from "./render-device";
import type { JsonObject } from "./scene-utils";
import { untrustedResult } from "./tools";

function objectOrNull(value: unknown): JsonObject | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return null;
}

// The frame's panel as a render size: only whole pixels the renderer accepts.
function renderSizeFrom(width: unknown, height: unknown): { width: number; height: number } | null {
  const valid = (side: unknown): side is number =>
    typeof side === "number" &&
    Number.isInteger(side) &&
    side >= minRenderDimension &&
    side <= maxRenderDimension;
  return valid(width) && valid(height) && width * height <= maxRenderPixels
    ? { height, width }
    : null;
}

// The scenes assigned to a frame, in rail order, by store id and name: what
// the context lists and what the voice tools switch between.
export async function assignedScenes(
  db: ReturnType<typeof createDb>,
  frameId: string,
): Promise<{ sceneId: string; name: string }[]> {
  return db
    .select({ name: storeScenes.name, sceneId: frameSceneAssignments.sceneId })
    .from(frameSceneAssignments)
    .innerJoin(storeScenes, eq(storeScenes.id, frameSceneAssignments.sceneId))
    .where(eq(frameSceneAssignments.frameId, frameId))
    .orderBy(asc(frameSceneAssignments.position));
}

export async function frameContextBlock(
  db: ReturnType<typeof createDb>,
  accountId: string,
  frameId: string | null,
): Promise<{
  block: string;
  frameId: string | null;
  renderDevice?: RenderDevice | null;
  resolution?: { width: number; height: number } | null;
}> {
  if (!frameId) {
    return { block: "", frameId: null };
  }
  const frame = await frameForAccount(db, accountId, frameId);
  if (!frame) {
    return { block: "", frameId: null };
  }
  const hardware = objectOrNull(frame.hardware) ?? {};
  const lines: string[] = ["The user is working with this frame:"];
  lines.push(`- Frame id: ${frame.id}`);
  if (frame.name) {
    lines.push(`- Name: ${frame.name}`);
  }
  const width = hardware.width;
  const height = hardware.height;
  if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
    lines.push(`- Resolution: ${width}x${height}`);
  }
  if (typeof hardware.device === "string" && hardware.device) {
    lines.push(`- Device: ${hardware.device}`);
  }
  if (typeof hardware.color === "string" && hardware.color) {
    lines.push(`- Color mode: ${hardware.color}`);
  }
  const renderDevice = frameRenderDevice(frame);
  if (renderDevice) {
    lines.push(
      `- Memory: ${renderDevice.label}. A scene that needs more aborts on the frame; render_scene renders in the same memory.`,
    );
  }
  lines.push(`- Connected: ${frame.connected ? "yes" : "no"} (status: ${frame.status})`);
  const assignments = await assignedScenes(db, frame.id);
  if (assignments.length > 0) {
    // Scene names are publisher-authored text; they enter the context only
    // inside the untrusted frame the tool results use.
    lines.push(
      "- Assigned scenes: " +
        untrustedResult(
          "assigned_scene_names",
          assignments.map((row) => `${row.name} (${row.sceneId})`).join(", "),
        ),
    );
  } else {
    lines.push("- No scenes assigned yet.");
  }
  return {
    block: lines.join("\n"),
    frameId: frame.id,
    renderDevice,
    resolution: renderSizeFrom(width, height),
  };
}
