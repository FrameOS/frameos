import { type createDb, frames } from "@frameos-cloud/db";
import {
  enqueueFrameCommand,
  enqueueFrameSettingsPush,
  frameSettingsRefusal,
  readFrameSettings,
  redeployAssignedScenesToFrame,
  supersedePendingCommands,
  validateFrameSchedule,
  type RedeployOutcome,
} from "./frames";
import { deviceSchedulePayload } from "./scene-images";

type Database = ReturnType<typeof createDb>;

export interface BackendReleaseReplay {
  // Why the settings were not sent again, or null when they were (or there
  // were none to send).
  settingsRefusal: string | null;
  settings: boolean;
  schedule: boolean;
  scenes: RedeployOutcome | null;
}

/**
 * Everything a cloud ESP32 refused while a self-hosted backend held it
 * (`backend_managed`), queued again once a hello reports the backend gone:
 * the frame's settings, its schedule, then its scenes, last so the first
 * render after the drain shows them. What the cloud holds is the owner's
 * latest intent; the device kept the backend's copy meanwhile.
 */
export async function replayCloudContentToFrame(
  db: Database,
  frame: typeof frames.$inferSelect,
): Promise<BackendReleaseReplay> {
  const out: BackendReleaseReplay = { scenes: null, schedule: false, settings: false, settingsRefusal: null };

  const stored = readFrameSettings(frame.settings);
  if (Object.keys(stored).length > 0) {
    const settings = { ...stored, name: frame.name };
    const refusal = frameSettingsRefusal(frame, settings);
    if (refusal) {
      out.settingsRefusal = refusal.error;
    } else {
      await enqueueFrameSettingsPush(db, frame, settings, { createdByAccountId: frame.accountId });
      out.settings = true;
    }
  }

  const { schedule } = validateFrameSchedule(frame.schedule);
  if (schedule) {
    await supersedePendingCommands(db, frame.id, "set_schedule");
    await enqueueFrameCommand(db, {
      createdByAccountId: frame.accountId,
      frameId: frame.id,
      payload: { schedule: await deviceSchedulePayload(db, frame.id, schedule) },
      type: "set_schedule",
    });
    out.schedule = true;
  }

  if (frame.assignedChecksum) {
    out.scenes = await redeployAssignedScenesToFrame(db, { accountId: frame.accountId, frame });
  }
  return out;
}
