import React from 'react'
import { clsx } from 'clsx'

export function H6({ children, className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h6 className={clsx('text-xl font-bold text-white', className)} {...props}>
      {children}
    </h6>
  )
}
