import React from 'react'
import { clsx } from 'clsx'

export interface MasonryProps extends React.HTMLAttributes<HTMLDivElement> {
  containerClassname?: string
  children: React.ReactNode
}

export function Masonry({ children, className, containerClassname, ...props }: MasonryProps) {
  return (
    <div className={clsx('@container w-full', containerClassname)} {...props}>
      <div
        className={clsx(
          'columns-1 @xs:columns-2 @md:columns-3 @2xl:columns-4 @5xl:columns-5 @7xl:columns-6 gap-4',
          className
        )}
        {...props}
      >
        {children}
      </div>
    </div>
  )
}
