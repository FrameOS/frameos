import { A } from 'kea-router'
import React from 'react'
import { H5 } from './H5'

interface HeaderProps {
  title: React.ReactNode
  right?: React.ReactNode | string
  buttons?: React.ReactElement
}

export function Header({ title, right, buttons }: HeaderProps) {
  return (
    <div
      className="bg-gray-800 text-white h-full w-full space-x-2 p-2 pt-3 px-4 flex justify-between items-center"
      style={{ height: 60 }}
    >
      <H5 className="truncate">
        <A href="/"><img src='/mark-white.svg' className="w-6 h-6 inline-block mr-2 align-baseline" alt="FrameOS" /></A>
        {title}
      </H5>
      <div className="flex space-x-2">
        {right && <div>{right}</div>}
        {buttons}
      </div>
    </div>
  )
}
