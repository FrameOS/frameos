import type { ReactElement } from 'react'

import { FrameosLogo } from '../../../frontend/src/components/FrameosLogo'
import { accountNavUrls } from '../cloudConfig'

// The FrameOS Cloud account chrome, mirroring
// cloud/apps/auth-web/src/components/AppShell.tsx: wordmark, then Scenes /
// Frames / Account / Sign out. It sits ABOVE the workspace shell and never
// re-renders per route — App.tsx renders it once, outside the scene Suspense
// boundary, and the shell below it gets the rest of the viewport (see the
// .frameos-cloud-app rules in src/index.css).
//
// Sign out is a POST form, not a link: GET logout is trivially triggerable
// from an <img> on any page, so the route only accepts POST. The three link
// targets and the logout URL come from the server through the shell config —
// account, scenes and auth can live on three different origins.
//
// The "Admin" entry AppShell shows to superadmins is deliberately absent: this
// bundle has no session, and a link that 403s for almost everyone is worse
// than one more click through Account.
export function AccountHeader(): ReactElement {
  const { accountUrl, framesUrl, logoutUrl, scenesUrl } = accountNavUrls()

  return (
    <header className="frameos-account-header">
      <a aria-label="FrameOS Account" className="frameos-account-header__brand" href={accountUrl}>
        <FrameosLogo alt="" className="frameos-account-header__logo frameos-account-header__logo--light h-6 w-auto" />
        <FrameosLogo
          alt=""
          variant="white-colors"
          className="frameos-account-header__logo frameos-account-header__logo--dark h-6 w-auto"
        />
        <span className="frameos-account-header__name">FrameOS Account</span>
      </a>
      <nav aria-label="Primary" className="frameos-account-header__nav">
        <a className="frameos-account-header__link" href={scenesUrl}>
          Scenes
        </a>
        <a className="frameos-account-header__link" href={framesUrl}>
          Frames
        </a>
        <a className="frameos-account-header__link" href={accountUrl}>
          Account
        </a>
        <form action={logoutUrl} method="post">
          <button className="frameos-account-header__link" type="submit">
            Sign out
          </button>
        </form>
      </nav>
    </header>
  )
}
