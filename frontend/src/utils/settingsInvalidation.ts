// A one-line bridge between whatever writes settings (the settings form,
// sshKeysLogic saving `ssh_keys` straight to /api/settings) and whatever keeps
// a copy (the settings form, the wasm preview's cached keys). Deliberately not an import of
// settingsLogic: that logic's graph (socket, user, frames) is the legacy
// workspace, which the cloud's strict type program must not reach through
// components it shares (see cloud/apps/auth-web/tsconfig.json).

type SettingsListener = () => void

const listeners = new Set<SettingsListener>()

/** settingsLogic registers its reload here while mounted; wasmPreviewModel drops its cache. */
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
