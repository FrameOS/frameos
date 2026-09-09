import type { WorkspaceMode } from './workspaceSurfaces'

// What "Delete frame" means depends on the control plane, so the words do
// too. On the self-hosted backend the frame row owns its scenes and there is
// an archive to point at instead. On the cloud there is no archive, the
// scenes live in the account's store and survive, and DELETE
// /api/frames/{id} revokes the device's link first — the device keeps
// showing what it has and drops back to standalone. Pinned by the cloud's
// node suite; keep the three call sites (the frames-home menu, the frame
// card, the settings panel) on this one module.

export interface FrameDeleteCopy {
  /** Menu entry tooltip. */
  title: string
  /** The confirmation question. */
  confirm: (frameName: string) => string
}

const backendDeleteCopy: FrameDeleteCopy = {
  title: 'Permanently delete this frame and all of its scenes',
  confirm: (frameName) =>
    `Delete the frame "${frameName}" and all of its scenes? This cannot be undone. ` +
    '(Archive it instead to hide it without losing anything.)',
}

const cloudDeleteCopy: FrameDeleteCopy = {
  title: 'Remove this frame from your account',
  confirm: (frameName) =>
    `Remove "${frameName}" from FrameOS Cloud? The device keeps showing the scenes it has and goes back to ` +
    'standalone mode; its cloud logs, metrics and history are deleted. Your scenes stay in your account. ' +
    'This cannot be undone — to manage it again, enroll it with a new claim code.',
}

export const frameDeleteCopyByMode: Record<WorkspaceMode, FrameDeleteCopy> = {
  backend: backendDeleteCopy,
  // The on-device admin manages the frame it runs on; its settings panel
  // hides Delete, so this entry only keeps the mode contract complete.
  frameAdmin: backendDeleteCopy,
  cloud: cloudDeleteCopy,
}

export function frameDeleteCopy(mode: WorkspaceMode): FrameDeleteCopy {
  return frameDeleteCopyByMode[mode]
}
