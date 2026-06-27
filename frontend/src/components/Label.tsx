import React from 'react'
import { clsx } from 'clsx'

export function Label({ children, className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label className={clsx('frameos-form-label text-sm font-medium flex items-top  @md:pt-2.5 gap-1', className)} {...props}>
      {children}
    </label>
  )
}
