import { A } from 'kea-router'
import React from 'react'
import { H5 } from './H5'
import { urls } from '../urls'
import { isInFrameAdminMode } from '../utils/frameAdmin'
import { FrameosLogo } from './FrameosLogo'

interface HeaderProps {
  title: React.ReactNode
  version?: string
  right?: React.ReactNode | string
  buttons?: React.ReactElement
}

export function Header({ title, version, right, buttons }: HeaderProps) {
  const inFrameAdminMode = isInFrameAdminMode()
  const homeHref = inFrameAdminMode ? urls.frameControl() : urls.frames()

  return (
    <span
      className="frameos-panel relative z-30 overflow-visible h-full w-full space-x-2 p-2 pt-3 px-4 flex justify-between items-center"
      style={{ height: 60 }}
    >
      <div className="min-w-0 flex flex-1 items-center justify-start gap-3">
        <A href={homeHref}>
          <FrameosLogo className="inline-block h-[28px] w-[28px] align-middle" />
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
