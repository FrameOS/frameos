import { Cog6ToothIcon } from '@heroicons/react/24/outline'
import { urls } from '../../urls'

// The rail's gear on the cloud. The global settings there are an account
// page, not a scene of this SPA, so this is a plain link that leaves the
// workspace — no router push, no pending spinner, never "active". Drawn by
// both the ready shell (FrameosShell) and its loading placeholder
// (WorkspaceRouteLoading), which must stay pixel-identical.
export function AccountSettingsRailLink(): JSX.Element {
  return (
    <a
      href={urls.settings()}
      title="Account settings"
      className="frameos-nav-button flex h-12 w-12 items-center justify-center rounded-xl text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
    >
      <Cog6ToothIcon className="h-8 w-8" />
    </a>
  )
}
