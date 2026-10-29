import type { FrameType } from '../types'

// The console lines that take a self-hosted backend off an ESP32, so the cloud
// it is linked to can change it again (fos_console.c print_backend_owns_cloud_frame).
export const handBackConsoleCommands = ['set backend ""', 'set api_key ""', 'set frame_id 0', 'restart']

/** A cloud frame a self-hosted backend holds (it reports `hardware.backend`). */
export function frameHasOwningBackend(frame: Pick<FrameType, 'owning_backend'>): boolean {
  return typeof frame.owning_backend === 'string' && frame.owning_backend.trim() !== ''
}

/** "10.4.0.47:8991"; null when there is none or the frame could not read its URL. */
export function frameOwningBackendHost(frame: Pick<FrameType, 'owning_backend'>): string | null {
  const origin = typeof frame.owning_backend === 'string' ? frame.owning_backend.trim() : ''
  if (!origin || origin === 'unknown') {
    return null
  }
  return origin.replace(/^https?:\/\//i, '')
}
