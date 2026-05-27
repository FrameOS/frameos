import React from 'react'
import { clsx } from 'clsx'

export function H6({ children, className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h6 className={clsx('frameos-heading text-xl font-bold', className)} {...props}>
      {children}
    </h6>
  )
}
