import type { ReactElement } from 'react'

import { accountNavUrls } from '../cloudConfig'

// The FrameOS Cloud chrome, rendered from the same stylesheet as
// cloud/apps/auth-web's shells (cloud-chrome.css, imported via src/index.css):
// the cloud logo, the wordmark (linking to /frames, the cloud's home), then
// Frames / Scenes / Account / Sign out. It
// sits ABOVE the workspace shell and never re-renders per route — App.tsx
// renders it once, outside the scene Suspense boundary, and the shell below it
// gets the rest of the viewport (see the .frameos-cloud-app rules in
// src/index.css).
//
// The logo is the cloud's own (/logo-light.svg + /logo-dark.svg), served from
// the Next app's public/ directory at the origin root — the same files the
// store and account headers show, not the generic FrameOS mark. The SPA is
// always served by that app (app/frames/[[...path]]/route.ts), so the
// root-absolute path holds in dev and prod alike.
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
      <div className="frameos-account-header__lead">
        <a aria-label="FrameOS Cloud" className="frameos-account-header__brand" href={framesUrl}>
          <img
            alt=""
            className="frameos-account-header__logo frameos-account-header__logo--light"
            height={24}
            src="/logo-light.svg"
            width={36}
          />
          <img
            alt=""
            className="frameos-account-header__logo frameos-account-header__logo--dark"
            height={24}
            src="/logo-dark.svg"
            width={36}
          />
          <span className="frameos-account-header__name">FrameOS Cloud</span>
        </a>
      </div>
      <nav aria-label="Primary" className="frameos-account-header__nav">
        <a className="frameos-account-header__link" href={framesUrl}>
          Frames
        </a>
        <a className="frameos-account-header__link" href={scenesUrl}>
          Scenes
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
