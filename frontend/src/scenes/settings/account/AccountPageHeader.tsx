import type { ReactNode } from 'react'

import { accountPage, type AccountPageKey } from './accountPages'

// The heading every account page starts with: its title and one line of
// what it is for (accountPages.ts), with room on the right for the page's
// own buttons (Save and Reset, a filter toggle).
export function AccountPageHeader({ page, actions }: { page: AccountPageKey; actions?: ReactNode }): JSX.Element {
  const entry = accountPage(page)
  return (
    <div className="settings-page-header mb-6">
      <div className="min-w-0">
        <h1 className="frameos-strong text-3xl font-bold tracking-normal text-slate-950">{entry.title}</h1>
        <p className="frameos-muted mt-1 max-w-3xl text-sm leading-relaxed">{entry.description}</p>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

/** A titled block of a page: an H2 and a sentence, then the card. */
export function AccountSection({
  id,
  title,
  description,
  children,
}: {
  id?: string
  title: string
  description?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <section id={id} className="space-y-3">
      <div>
        <h2 className="frameos-heading text-xl font-bold">{title}</h2>
        {description ? <p className="frameos-muted mt-1 text-sm leading-relaxed">{description}</p> : null}
      </div>
      {children}
    </section>
  )
}

/** One line of feedback under a form: an error or a success note. */
export function AccountNotice({
  tone,
  children,
}: {
  tone: 'error' | 'success' | 'info'
  children: ReactNode
}): JSX.Element {
  const className =
    tone === 'error'
      ? 'border-red-500/40 bg-red-500/10 text-red-700'
      : tone === 'success'
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700'
      : 'frameos-inset border'
  return (
    <p role={tone === 'error' ? 'alert' : 'status'} className={`rounded-lg border p-3 text-sm ${className}`}>
      {children}
    </p>
  )
}

/** The account pages' tables: one class set so they all read alike. */
export function AccountTable({ head, children }: { head: ReactNode[]; children: ReactNode }): JSX.Element {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="frameos-muted text-left text-xs uppercase tracking-wide">
            {head.map((cell, index) => (
              <th key={index} className="py-2 pr-3 font-semibold">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-500/10">{children}</tbody>
      </table>
    </div>
  )
}
