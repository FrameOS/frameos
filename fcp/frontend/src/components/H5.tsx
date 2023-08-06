import React from 'react'
import { clsx } from 'clsx'

export function H5({ children, className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h5 className={clsx('text-3xl font-bold text-white', className)} {...props}>
      {children}
    </h5>
  )
}
