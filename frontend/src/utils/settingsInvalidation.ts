// A one-line bridge between logics that write settings groups on their own
// (sshKeysLogic saves `ssh_keys` straight to /api/settings) and the settings
// page's form, which keeps its own copy. Deliberately not an import of
// settingsLogic: that logic's graph (socket, user, frames) is the legacy
// workspace, which the cloud's strict type program must not reach through
// components it shares (see cloud/apps/auth-web/tsconfig.json).

type SettingsListener = () => void

const listeners = new Set<SettingsListener>()

/** settingsLogic registers its reload here while mounted. */
export function onSettingsChanged(listener: SettingsListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Tell every mounted settings form that a group changed server-side. */
export function notifySettingsChanged(): void {
  for (const listener of Array.from(listeners)) {
    listener()
  }
}
