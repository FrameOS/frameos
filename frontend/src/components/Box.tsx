import React from 'react'
import { clsx } from 'clsx'

export function Box({ children, className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <div className={clsx('border rounded-lg shadow bg-gray-800 border-gray-700', className)} {...props}>
      {children}
    </div>
  )
}
