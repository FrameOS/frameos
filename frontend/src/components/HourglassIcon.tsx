import type { SVGProps } from 'react'

/**
 * An hourglass in the heroicons outline style (24px grid, 1.5 stroke), for
 * the "queued" states: a request the frame has not taken yet. Heroicons has
 * no hourglass, and the clock it stood in for reads as "scheduled" or
 * "history" everywhere else in the workspace.
 */
export function HourglassIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M6.75 3h10.5M6.75 21h10.5" />
      <path d="M8.25 3v2.4c0 1.3.55 2.55 1.5 3.45L12 11.25l2.25-2.4c.95-.9 1.5-2.15 1.5-3.45V3" />
      <path d="M8.25 21v-2.4c0-1.3.55-2.55 1.5-3.45L12 12.75l2.25 2.4c.95.9 1.5 2.15 1.5 3.45V21" />
      <path d="M10.5 18.75h3" fill="currentColor" />
    </svg>
  )
}
