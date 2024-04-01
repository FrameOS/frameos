import { SVGProps } from 'react'

export function ZoomOutArea(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 32 32" {...props}>
      <path fill="currentColor" d="M16 19h8v2h-8z"></path>
      <path
        fill="currentColor"
        d="m31 29.586l-4.688-4.688a8.028 8.028 0 1 0-1.415 1.414L29.586 31zM20 26a6 6 0 1 1 6-6a6.007 6.007 0 0 1-6 6M4 8H2V4a2.002 2.002 0 0 1 2-2h4v2H4zm22 0h-2V4h-4V2h4a2.002 2.002 0 0 1 2 2zM12 2h4v2h-4zM8 26H4a2.002 2.002 0 0 1-2-2v-4h2v4h4zM2 12h2v4H2z"
      ></path>
    </svg>
  )
}
