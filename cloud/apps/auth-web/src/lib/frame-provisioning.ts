// "Start this frame with the scenes from <that frame>" and the layout it
// starts with, chosen while building the SD image or flashing the board and
// carried on the frame row (frames.scene_source_frame_id,
// frames.provisioning_layout; docs/scene-layouts.md "Chosen at the flash").
//
// Runs when the frame turns active: at the owner's Confirm click for every
// multi-use-token enrollment (an SD image can be copied, so its first
// redeemer proves nothing), and at enrollment itself for single-use tokens
// (which are born active — the mint was the owner's deliberate act, and a
// single-use budget means only one device can ever redeem it). In both
// cases the source frame is the token minter's, re-checked at use time, and
// the copy goes through the same assignScenesToFrame gates a workspace
// deploy does — accessibility, pinned version, shell-risk refusal.
//
// Best effort, and the intent is cleared either way: the activation itself
// has already committed, the frame is usable without its scenes, and a copy
// that retried on every subsequent call would fight the owner's own edits.
// Failures are reported, never raised.

import { eq } from "drizzle-orm";
import { type createDb, frames } from "@frameos-cloud/db";
import {
  assignScenesToFrame,
  currentSceneAssignments,
  type RequestedScene,
} from "./frame-scenes";
import { buildScenesPayloadForFrame, frameForAccount } from "./frames";
import { reportError } from "./log";
import {
  provisioningLayoutOf,
  runtimeScenesByStoreScene,
  withProvisioningLayout,
} from "./provisioning-layout";

export async function applyProvisioningScenes(
  db: ReturnType<typeof createDb>,
  input: {
    accountId: string;
    actor: unknown;
    frame: typeof frames.$inferSelect;
  },
) {
  const sourceFrameId = input.frame.sceneSourceFrameId;
  // The layout chosen beside the flash (provisioning-layout.ts): installed
  // after the copied scenes, and worn by each of them.
  const layout = provisioningLayoutOf(input.frame.provisioningLayout);
  if (!sourceFrameId && !layout) {
    return;
  }
  try {
    await db
      .update(frames)
      .set({ provisioningLayout: null, sceneSourceFrameId: null })
      .where(eq(frames.id, input.frame.id));
    let requested: RequestedScene[] = [];
    let sourceScenes: unknown[] = [];
    if (sourceFrameId) {
      // Re-check ownership at use time, not just at mint time: the source
      // frame may have been deleted, or the account may have changed hands,
      // in the days between building the card and booting it.
      const source = await frameForAccount(db, input.accountId, sourceFrameId);
      if (source && source.id !== input.frame.id) {
        requested = await currentSceneAssignments(db, source.id);
        if (layout && requested.length > 0) {
          // Which runtime scenes each copied assignment holds, to put the
          // layout on them: read off what the source frame is sent. A source
          // that cannot be built (a pulled scene) still gets its copy, then
          // refused by the gates below like any other push.
          const built = await buildScenesPayloadForFrame(db, source.id);
          if (!("error" in built)) {
            sourceScenes = built.scenes;
          }
        }
      }
    }
    if (layout) {
      requested = withProvisioningLayout(requested, runtimeScenesByStoreScene(sourceScenes), layout);
    }
    if (requested.length === 0) {
      return;
    }
    const outcome = await assignScenesToFrame(db, {
      accountId: input.accountId,
      actor: input.actor,
      frame: input.frame,
      requested,
      via: "provisioning",
    });
    if (!outcome.ok) {
      reportError(
        "frames.provisioning_scene_copy_refused",
        new Error(outcome.failure.code),
      );
    }
  } catch (error) {
    reportError("frames.provisioning_scene_copy_failed", error);
  }
}
