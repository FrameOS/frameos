import { A } from 'kea-router'
import React from 'react'
import { H5 } from './H5'

interface HeaderProps {
  title: React.ReactNode
  subtitle?: string
  right?: React.ReactNode | string
  buttons?: React.ReactElement[]
}

export function Header({ title, subtitle, right, buttons = [] }: HeaderProps) {
  return (
    <div
      className="bg-gray-800 text-white h-full w-full space-x-2 p-2 pt-3 px-4 flex justify-between items-center"
      style={{ height: 60 }}
    >
      <H5 className="truncate">
        <A href="/">{title}</A>
        {subtitle && (
          <>
            {' '}
            <span className="text-gray-400">&raquo;</span> {subtitle}
          </>
        )}
      </H5>
      <div className="flex space-x-2">
        {right && <div>{right}</div>}
        {buttons.map((button, idx) => React.cloneElement(button, { key: idx }))}
      </div>
    </div>
  )
}
