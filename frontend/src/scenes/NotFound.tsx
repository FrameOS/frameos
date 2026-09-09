import type { ReactElement } from 'react'
import { A } from 'kea-router'
import { QuestionMarkCircleIcon } from '@heroicons/react/24/outline'
import { urls } from '../urls'
import { workspaceMode } from './workspace/workspaceSurfaces'

// The one 404 for all three shells (the self-hosted SPA, the cloud's
// /frames mount and the on-device admin panel). Both scene tables used to
// map `error404` to a bare `<div>404</div>`; a frame tool the control plane
// does not implement now lands here too (FrameWorkspace), so the page has to
// say which path failed and where to go instead.

export interface NotFoundProps {
  /** The path that did not resolve; defaults to the browser's location. */
  path?: string | null
  title?: string
  /** Replaces the default explanation. */
  message?: string | null
  /** Where the way out leads; the frames list by default. */
  link?: { href: string; label: string }
}

function attemptedPath(path: string | null | undefined): string | null {
  if (typeof path === 'string') {
    return path
  }
  if (typeof window === 'undefined') {
    return null
  }
  return window.location.pathname + window.location.search
}

export function homeLinkLabel(): string {
  // urls.frames() is the frame itself on the on-device admin panel: the
  // panel manages the one frame it runs on.
  return workspaceMode() === 'frameAdmin' ? 'Back to the frame' : 'Back to your frames'
}

/** The 404 card without a page wrapper, for rendering inside a workspace shell. */
export function NotFoundContent({ path, title = 'Page not found', message, link }: NotFoundProps): ReactElement {
  const attempted = attemptedPath(path)
  const href = link?.href ?? urls.frames()
  const label = link?.label ?? homeLinkLabel()
  return (
    <div className="frameos-muted text-center" data-testid="not-found">
      <QuestionMarkCircleIcon className="mx-auto mb-3 h-10 w-10 text-slate-300" aria-hidden="true" />
      <div className="text-base font-semibold">{title}</div>
      <div className="mt-1 text-sm">
        {message ??
          (attempted ? (
            <>
              There is nothing at{' '}
              <code className="break-all rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
                {attempted}
              </code>
              .
            </>
          ) : (
            'There is nothing at this address.'
          ))}
      </div>
      <div className="mt-4 text-sm">
        <A href={href} className="frameos-link underline decoration-slate-300 underline-offset-2">
          {label}
        </A>
      </div>
    </div>
  )
}

export function NotFound(props: NotFoundProps): ReactElement {
  return (
    <main className="flex min-h-[60vh] items-center justify-center px-4 py-12" role="main">
      <NotFoundContent {...props} />
    </main>
  )
}

export default NotFound
