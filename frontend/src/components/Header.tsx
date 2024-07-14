import { A } from 'kea-router'
import React from 'react'
import { H5 } from './H5'

interface HeaderProps {
  title: React.ReactNode
  version?: string
  right?: React.ReactNode | string
  buttons?: React.ReactElement
}

export function Header({ title, version, right, buttons }: HeaderProps) {
  return (
    <span
      className="bg-gray-800 text-white h-full w-full space-x-2 p-2 pt-3 px-4 flex justify-between items-center"
      style={{ height: 60 }}
    >
      <div className="truncate flex items-center justify-center gap-3">
        <A href="/">
          <img
            src="/img/logo/dark-mark-small.png"
            className="w-[28px] h-[28px] inline-block align-center"
            alt="FrameOS"
          />
        </A>
        {version ? (
          <H5 className="flex items-end gap-1">
            <span>{title}</span>
            <span className="text-xs font-normal mt-1">{version}</span>
          </H5>
        ) : (
          <H5>{title}</H5>
        )}
      </div>
      <div className="flex space-x-2">
        {right && <div>{right}</div>}
        {buttons}
      </div>
    </span>
  )
}
