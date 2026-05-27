import { A } from 'kea-router'
import { useActions, useValues } from 'kea'
import { MoonIcon, SunIcon } from '@heroicons/react/24/outline'
import clsx from 'clsx'
import type { ReactNode } from 'react'
import { FrameosLogo } from '../../components/FrameosLogo'
import { authThemeLogic } from './authThemeLogic'

interface AuthScreenProps {
  title: string
  subtitle?: string
  children: JSX.Element
  footer?: JSX.Element
}

export function AuthScreen({ title, subtitle, children, footer }: AuthScreenProps): JSX.Element {
  const { theme } = useValues(authThemeLogic)
  const { toggleTheme } = useActions(authThemeLogic)

  return (
    <div
      className={clsx(
        'frameos-auth-screen frameos-app-shell flex min-h-screen w-full items-center justify-center px-4 py-8 text-slate-900',
        `frameos-theme-${theme}`
      )}
    >
      <button
        type="button"
        title={theme === 'dark' ? 'Use light mode' : 'Use dark mode'}
        onClick={toggleTheme}
        className="frameos-icon-button auth-button fixed right-5 top-5 flex h-12 w-12 items-center justify-center rounded-xl bg-white/80 text-slate-500 shadow-lg shadow-slate-300/25 transition hover:bg-white hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      >
        {theme === 'dark' ? <SunIcon className="h-6 w-6" /> : <MoonIcon className="h-6 w-6" />}
      </button>
      <main className="frameos-panel w-full max-w-[25rem] overflow-hidden rounded-[24px] border border-white/80 bg-white/90 shadow-2xl shadow-slate-400/30 backdrop-blur-xl">
        <div className="px-6 pb-5 pt-6">
          <div className="mb-7 flex items-center gap-3">
            <FrameosLogo variant={theme === 'dark' ? 'white-colors' : 'color'} className="h-11 w-11 shrink-0" />
            <div className="min-w-0">
              <div className="frameos-muted text-xs font-semibold uppercase tracking-wide text-slate-400">FrameOS</div>
              <h1 className="frameos-strong truncate text-2xl font-bold tracking-normal text-slate-950">{title}</h1>
            </div>
          </div>
          {subtitle ? <p className="frameos-muted mb-6 text-sm leading-6 text-slate-500">{subtitle}</p> : null}
          {children}
        </div>
        {footer ? (
          <div className="frameos-divider border-t border-slate-200/80 bg-slate-50/70 px-6 py-4 text-center text-sm text-slate-500">
            {footer}
          </div>
        ) : null}
      </main>
    </div>
  )
}

export function AuthLink({ href, children }: { href: string; children: ReactNode }): JSX.Element {
  return (
    <A href={href} className="frameos-link font-semibold transition">
      {children}
    </A>
  )
}
