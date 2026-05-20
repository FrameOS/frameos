import { A } from 'kea-router'
import React from 'react'
import { H5 } from './H5'
import { urls } from '../urls'
import { assetUrl } from '../utils/assetUrl'
import { frameAdminPath, isInFrameAdminMode } from '../utils/frameAdmin'

import darkMarkSmall from '../assets/logo/dark-mark-small.png'

interface HeaderProps {
  title: React.ReactNode
  version?: string
  right?: React.ReactNode | string
  buttons?: React.ReactElement
}

export function Header({ title, version, right, buttons }: HeaderProps) {
  const inFrameAdminMode = isInFrameAdminMode()
  const homeHref = inFrameAdminMode ? frameAdminPath() : urls.frames()

  return (
    <span
      className="relative z-30 overflow-visible bg-gray-800 text-white h-full w-full space-x-2 p-2 pt-3 px-4 flex justify-between items-center"
      style={{ height: 60 }}
    >
      <div className="min-w-0 flex flex-1 items-center justify-start gap-3">
        <A href={homeHref}>
          <img src={assetUrl(darkMarkSmall)} className="w-[28px] h-[28px] inline-block align-center" alt="FrameOS" />
        </A>
        {version ? (
          <H5 className="flex min-w-0 items-end gap-1">
            <span className="truncate">{title}</span>
            <span className="text-xs font-normal mt-1">{version}</span>
          </H5>
        ) : (
          <H5 className="min-w-0 truncate">{title}</H5>
        )}
      </div>
      <div className="flex shrink-0 items-center space-x-2">
        {right && <div>{right}</div>}
        {buttons}
      </div>
    </span>
  )
}
