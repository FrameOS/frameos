import { useState, type ReactElement } from 'react'

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
//
// Everything this bundle serves lives under /frames, so "Frames" is always
// the active entry. Below 40rem the links fold into a panel behind the
// hamburger (cloud-chrome.css), mirroring auth-web's HeaderNav.tsx.
export function AccountHeader(): ReactElement {
  const { accountUrl, framesUrl, logoutUrl, scenesUrl } = accountNavUrls()
  const [open, setOpen] = useState(false)

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
      <button
        aria-controls="frameos-primary-nav"
        aria-expanded={open}
        aria-label={open ? 'Close menu' : 'Open menu'}
        className="frameos-account-header__toggle"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {open ? <CloseIcon /> : <MenuIcon />}
      </button>
      <nav
        aria-label="Primary"
        className={
          open ? 'frameos-account-header__nav frameos-account-header__nav--open' : 'frameos-account-header__nav'
        }
        id="frameos-primary-nav"
      >
        <a
          aria-current="page"
          className="frameos-account-header__link frameos-account-header__link--active"
          href={framesUrl}
        >
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

function MenuIcon(): ReactElement {
  return (
    <svg aria-hidden fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth={2} viewBox="0 0 24 24">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  )
}

function CloseIcon(): ReactElement {
  return (
    <svg aria-hidden fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth={2} viewBox="0 0 24 24">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}
