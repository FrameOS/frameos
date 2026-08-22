import { useRef, useState, type ReactElement } from 'react'

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
  const betaDialogRef = useRef<HTMLDialogElement>(null)

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
        <button
          aria-haspopup="dialog"
          className="frameos-account-header__beta"
          onClick={() => betaDialogRef.current?.showModal()}
          title="What beta means"
          type="button"
        >
          beta
        </button>
        {/* Same copy as auth-web's BetaBadge.tsx — keep the two in step. */}
        <dialog
          aria-labelledby="frameos-beta-title"
          className="frameos-beta-dialog"
          onClick={(event) => {
            if (event.target === betaDialogRef.current) {
              betaDialogRef.current?.close()
            }
          }}
          ref={betaDialogRef}
        >
          <div className="frameos-beta-dialog__body">
            <h2 id="frameos-beta-title">FrameOS Cloud is in beta</h2>
            <p>
              The cloud is new and still changing. It works — frames enroll, scenes deploy — but expect rough edges, and
              expect things to move around.
            </p>
            <ul>
              <li>
                <strong>It is free while in beta.</strong> Limits (frames, storage, logs) exist so one account cannot
                crowd out the rest; they may change.
              </li>
              <li>
                <strong>Your data stays yours.</strong> Scenes, backups and frame settings can be exported from your
                account at any time, every frame keeps working on its own if the cloud is unreachable, and easy cloud ↔
                self-hosted migrations are coming.
              </li>
              <li>
                <strong>Self-hosting is not going anywhere.</strong> The cloud is an option next to the self-hosted
                FrameOS backend, not a replacement for it. The cloud itself is open source too — you can run your own,
                though we do not recommend it yet.
              </li>
              <li>
                <strong>Tell us what breaks.</strong> Bugs and ideas are welcome on{' '}
                <a href="https://github.com/FrameOS/frameos/issues" rel="noreferrer" target="_blank">
                  GitHub
                </a>{' '}
                or{' '}
                <a href="https://discord.gg/9dT9y7EzUw" rel="noreferrer" target="_blank">
                  Discord
                </a>
                .
              </li>
            </ul>
            <div className="frameos-beta-dialog__actions">
              <button
                className="frameos-beta-dialog__close"
                onClick={() => betaDialogRef.current?.close()}
                type="button"
              >
                Got it
              </button>
            </div>
          </div>
        </dialog>
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
