import React from 'react'
import { clsx } from 'clsx'

export function H5({ children, className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h5 className={clsx('frameos-heading text-2xl font-bold', className)} {...props}>
      {children}
    </h5>
  )
}
