import React from 'react'
import { clsx } from 'clsx'

// Inline or block code, in the theme's inset colors (frameos-inset: a pale
// panel in light mode, a graphite one in dark) rather than a fixed dark
// blue that only ever matched the old dark-only backend UI. A `block`
// caller gets a wrapped, scrollable code box; the default is an inline chip.
export function Code({ children, className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <code
      className={clsx(
        'frameos-inset rounded-md border px-1.5 py-0.5 font-mono text-xs leading-relaxed text-[color:var(--tool-strong,inherit)] [&.block]:overflow-x-auto [&.block]:whitespace-pre-wrap [&.block]:rounded-lg [&.block]:px-3 [&.block]:py-2',
        className
      )}
      {...props}
    >
      {children}
    </code>
  )
}
