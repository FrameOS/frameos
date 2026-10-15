import { useActions } from 'kea'
import { A, router } from 'kea-router'
import clsx from 'clsx'
import { useEffect } from 'react'

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
    <nav aria-label="Settings pages" className="space-y-1">
      {accountPages.map((entry) => (
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
            'frameos-settings-nav-link block rounded-xl px-3 py-2.5 text-base font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
            entry.key === current ? 'frameos-settings-nav-link-active' : 'text-slate-700 hover:bg-slate-100'
          )}
        >
          {entry.label}
        </A>
      ))}
    </nav>
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
      <div className="frame-tool-panel frame-settings-panel settings-panel mx-auto max-w-5xl @container">
        <Page />
      </div>
    </FrameosShell>
  )
}
