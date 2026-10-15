import { useActions } from 'kea'
import { A, router } from 'kea-router'
import clsx from 'clsx'
import { useEffect, type ComponentType, type SVGProps } from 'react'
import {
  ArchiveBoxIcon,
  ArrowRightStartOnRectangleIcon,
  ChartBarIcon,
  ClockIcon,
  CodeBracketIcon,
  CommandLineIcon,
  KeyIcon,
  ServerStackIcon,
  ShieldCheckIcon,
} from '@heroicons/react/24/outline'

import { urls } from '../../../urls'
import { FrameosShell } from '../../workspace/FrameosShell'
import { isMobileWorkspaceViewport, workspaceLogic } from '../../workspace/workspaceLogic'
import { accountPages, defaultAccountPageKey, isAccountPageKey, type AccountPageKey } from './accountPages'
import { ActivityPage } from './ActivityPage'
import { BackendsPage } from './BackendsPage'
import { BackupsPage } from './BackupsPage'
import { DeveloperPage } from './DeveloperPage'
import { SecurityPage } from './SecurityPage'
import { ServicesPage } from './ServicesPage'
import { SshKeysPage } from './SshKeysPage'
import { UsagePage } from './UsagePage'

// The side panel's icons live here, not in accountPages.ts: that file is
// pure data the cloud's tests read, and an icon is a React component.
const pageIcons: Record<AccountPageKey, ComponentType<SVGProps<SVGSVGElement>>> = {
  backends: ServerStackIcon,
  services: KeyIcon,
  ssh: CommandLineIcon,
  usage: ChartBarIcon,
  backups: ArchiveBoxIcon,
  activity: ClockIcon,
  security: ShieldCheckIcon,
  developer: CodeBracketIcon,
}

// Sign out lives at the bottom of this panel, always in view. It is a POST
// form, never a link: a GET logout is trivially triggerable from an <img>
// on any page, so the route only accepts POST. The URL is the auth origin's
// (cloud_logout_url, injected by the shell like cloud_reauth_url); the
// fallback only serves a shell served without injection.
function injectedLogoutUrl(): string {
  const injected = typeof window !== 'undefined' ? (window as any).FRAMEOS_APP_CONFIG?.cloud_logout_url : undefined
  return typeof injected === 'string' && injected ? injected : '/api/auth/logout'
}

const pageComponents: Record<AccountPageKey, () => JSX.Element> = {
  backends: BackendsPage,
  services: ServicesPage,
  ssh: SshKeysPage,
  usage: UsagePage,
  backups: BackupsPage,
  activity: ActivityPage,
  security: SecurityPage,
  developer: DeveloperPage,
}

// The cloud's settings: the account pages (accountPages.ts), one route each,
// listed in the settings side panel. The page in the URL renders; the bare
// /settings (and an unknown page) lands on the first one.
export function CloudSettings({ page }: { page?: string }): JSX.Element {
  const current: AccountPageKey = isAccountPageKey(page) ? page : defaultAccountPageKey
  const { closeSecondarySidebar } = useActions(workspaceLogic)

  useEffect(() => {
    if (!isAccountPageKey(page)) {
      router.actions.replace(urls.settings(defaultAccountPageKey))
    }
  }, [page])

  const tree = (
    <div className="flex min-h-full flex-col">
      <nav aria-label="Settings pages" className="space-y-1">
        {accountPages.map((entry) => {
          const Icon = pageIcons[entry.key]
          return (
            <A
              key={entry.key}
              href={urls.settings(entry.key)}
              aria-current={entry.key === current ? 'page' : undefined}
              onClick={() => {
                if (isMobileWorkspaceViewport()) {
                  closeSecondarySidebar()
                }
              }}
              className={clsx(
                'frameos-settings-nav-link flex items-center gap-3 rounded-xl px-3 py-2.5 text-base font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
                entry.key === current ? 'frameos-settings-nav-link-active' : 'text-slate-700 hover:bg-slate-100'
              )}
            >
              <Icon aria-hidden className="h-5 w-5 shrink-0 opacity-80" />
              <span className="min-w-0 truncate">{entry.label}</span>
            </A>
          )
        })}
      </nav>
      <form action={injectedLogoutUrl()} method="post" className="mt-auto pt-6">
        <button
          type="submit"
          className="frameos-settings-nav-link flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-base font-medium text-slate-700 transition hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          <ArrowRightStartOnRectangleIcon aria-hidden className="h-5 w-5 shrink-0 opacity-80" />
          <span>Sign out</span>
        </button>
      </form>
    </div>
  )

  const Page = pageComponents[current]

  return (
    <FrameosShell
      mode="settings"
      title="Settings"
      subtitle="Account"
      tree={tree}
      mainClassName="settings-workspace-main min-h-screen overflow-visible py-6 pr-8 max-lg:min-h-0 max-lg:px-4 max-lg:pb-6 max-lg:pt-0"
      topBar={null}
    >
      {/* pb-16: the main area scrolls, and a table that ends flush with the
          viewport reads as cut off. */}
      <div className="frame-tool-panel frame-settings-panel settings-panel mx-auto max-w-5xl pb-16 @container">
        <Page />
      </div>
    </FrameosShell>
  )
}
