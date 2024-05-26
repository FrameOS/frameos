import React from 'react'
import { clsx } from 'clsx'

export function Label({ children, className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label className={clsx('text-sm font-medium text-white flex items-center gap-1', className)} {...props}>
      {children}
    </label>
  )
}
