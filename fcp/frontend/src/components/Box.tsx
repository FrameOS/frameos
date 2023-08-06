import React from 'react'
import { clsx } from 'clsx'

export function Box({ children, className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h1 className={clsx('w-full border rounded-lg shadow bg-gray-800 border-gray-700', className)} {...props}>
      {children}
    </h1>
  )
}
