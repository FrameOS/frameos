// Who the signed-in account is to a frame (cloud/docs/sharing.md).
//
// FrameOS Cloud shares a frame with the people on its owner's plan through a
// project, and reports the answer as `access` on every frame it lists. The
// self-hosted backend and the frame's own admin panel send none: there the
// frame is simply yours, which is what a missing `access` reads as.
//
// The server decides what each role may do; this file is only how the
// workspace words it and which controls it leaves out. Import-free on
// purpose: workspaceSurfaces.ts and the cloud's node tests read it.

/** `owner`: the account the frame belongs to. `admin`: manages the owner's
 * people and projects. `member`: was added to the frame's project. */
export type FrameAccessRole = 'owner' | 'admin' | 'member'

export interface FrameAccess {
  role: FrameAccessRole
  /** The project the frame is shared through; null when it is in none. */
  project: { id: string; name: string } | null
  organization: { id: string; name: string } | null
  /** The frame's owner, when that is someone else. */
  owner_name?: string | null
}

export interface FrameWithAccess {
  access?: Partial<FrameAccess> | null
}

export function frameAccessRole(frame?: FrameWithAccess | null): FrameAccessRole {
  const role = frame?.access?.role
  return role === 'admin' || role === 'member' ? role : 'owner'
}

/** The frame belongs to someone else, who shares it with this account. */
export function frameIsSharedWithMe(frame?: FrameWithAccess | null): boolean {
  return frameAccessRole(frame) !== 'owner'
}

/** The account may flip the owner's switches on the frame: its service keys,
 * log shipping, the voice chat's permissions, local network access. */
export function canManageFrame(frame?: FrameWithAccess | null): boolean {
  return frameAccessRole(frame) !== 'member'
}

/** Shown beside a switch a member may not flip. */
export const frameManageOnlyNote = "Only the frame's owner, or an admin on their plan, can change this."

/**
 * The line under a frame's name: whose it is and through which project, for
 * a frame shared with this account; the project it is shared through, for
 * the owner's own. Null for a frame that is the owner's alone.
 */
export function frameSharingLabel(frame?: FrameWithAccess | null): string | null {
  const access = frame?.access
  if (!access) {
    return null
  }
  const project = access.project?.name ?? null
  if (frameIsSharedWithMe(frame)) {
    const owner = access.owner_name ?? access.organization?.name ?? null
    return owner ? `Shared by ${owner}` : 'Shared with you'
  }
  return project ? `Shared in ${project}` : null
}
