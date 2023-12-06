import React from 'react'
import { clsx } from 'clsx'

export function H4({ children, className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h5 className={clsx('text-4xl font-bold text-white', className)} {...props}>
      {children}
    </h5>
  )
}
