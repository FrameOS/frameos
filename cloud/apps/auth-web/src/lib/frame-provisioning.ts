// "Start this frame with the scenes from <that frame>", chosen while building
// the SD image or flashing the board and carried on the frame row
// (frames.scene_source_frame_id).
//
// Runs when the frame turns active: at the owner's Confirm click for
// multi-use-token enrollments, and at enrollment itself for single-use
// tokens (which are born active — the mint was the owner's deliberate act,
// and a single-use budget means only one device can ever redeem it). In both
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
} from "./frame-scenes";
import { frameForAccount } from "./frames";
import { reportError } from "./log";

export async function applyProvisioningScenes(
  db: ReturnType<typeof createDb>,
  input: {
    accountId: string;
    actor: unknown;
    frame: typeof frames.$inferSelect;
  },
) {
  const sourceFrameId = input.frame.sceneSourceFrameId;
  if (!sourceFrameId) {
    return;
  }
  try {
    await db
      .update(frames)
      .set({ sceneSourceFrameId: null })
      .where(eq(frames.id, input.frame.id));
    // Re-check ownership at use time, not just at mint time: the source frame
    // may have been deleted, or the account may have changed hands, in the
    // days between building the card and booting it.
    const source = await frameForAccount(db, input.accountId, sourceFrameId);
    if (!source || source.id === input.frame.id) {
      return;
    }
    const requested = await currentSceneAssignments(db, source.id);
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
