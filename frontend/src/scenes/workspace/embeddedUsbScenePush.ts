import { embeddedUsbUploadTimeoutMs } from '../../models/framesModel'
import { runEmbeddedUsbApiCommand } from '../../models/embeddedUsbLogsModel'
import type { FrameId, FrameScene } from '../../types'

/**
 * Send the workspace's current scenes to a board over its USB serial port —
 * the same `upload-scenes` command the over-the-air push delivers, for a board
 * that cannot reach the network.
 *
 * Shared by the standalone "Push scenes over USB" card and the firmware
 * updater's "Also push scenes & settings" tick, so the two cannot drift into
 * sending different bodies for the same words.
 *
 * Settings are deliberately NOT part of this: there is no USB verb for them.
 * A cloud frame picks them up (and confirms the scene push) the next time it
 * connects; a backend frame gets them on its next deploy.
 */
export async function pushScenesOverUsb(frameId: FrameId, scenes: FrameScene[]): Promise<void> {
  const payload = new TextEncoder().encode(JSON.stringify(scenes))
  await runEmbeddedUsbApiCommand(frameId, 'upload-scenes', {
    payload,
    timeoutMs: embeddedUsbUploadTimeoutMs(payload.byteLength),
  })
}

export function pushedScenesMessage(count: number): string {
  return `Pushed ${count} scene${count === 1 ? '' : 's'} over USB.`
}
