import clsx from 'clsx'
import type { ReactNode } from 'react'

interface AdvancedSectionProps {
  children: ReactNode
  /** Summary text; "advanced" unless the section has a more specific name. */
  label?: string
  /** Render expanded, e.g. when the current value is one of the hidden options. */
  open?: boolean
  className?: string
}

/**
 * Collapsed-by-default wrapper for settings most people never need. Native
 * <details>, so it works inside kea forms without extra state.
 */
export function AdvancedSection({ children, label = 'advanced', open, className }: AdvancedSectionProps): JSX.Element {
  return (
    <details className={clsx('min-w-0', className)} open={open}>
      <summary className="frameos-link cursor-pointer list-none text-sm font-semibold">{label}</summary>
      <div className="mt-3 space-y-3">{children}</div>
    </details>
  )
}
