import React from 'react'
import { clsx } from 'clsx'

export function H4({ children, className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h4 className={clsx('text-3xl font-bold text-white', className)} {...props}>
      {children}
    </h4>
  )
}
