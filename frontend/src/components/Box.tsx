import React from 'react'
import { clsx } from 'clsx'

export function Box({ children, className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={clsx('frameos-card border rounded-lg shadow break-inside-avoid', className)} {...props}>
      {children}
    </div>
  )
}
