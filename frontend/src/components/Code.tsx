import React from 'react'
import { clsx } from 'clsx'

export function Code({ children, className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <code className={clsx('text-xs bg-sky-950 p-1 border border-1 border-sky-900 rounded-md', className)} {...props}>
      {children}
    </code>
  )
}
