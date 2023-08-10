import React from 'react'
import { clsx } from 'clsx'

export function H1({ children, className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h1
      className={clsx(
        'mb-4 text-2xl font-extrabold leading-none tracking-tight md:text-3xl lg:text-4xl text-white',
        className
      )}
      {...props}
    >
      {children}
    </h1>
  )
}
