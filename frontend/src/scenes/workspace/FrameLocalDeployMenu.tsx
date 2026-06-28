import { useActions } from 'kea'
import { ArrowPathIcon, CloudArrowUpIcon, PowerIcon, RocketLaunchIcon } from '@heroicons/react/24/outline'
import { EllipsisHorizontalIcon } from '@heroicons/react/24/solid'
import clsx from 'clsx'
import type { ReactNode } from 'react'

import { DropdownMenu, type DropdownMenuProps } from '../../components/DropdownMenu'
import { framesModel } from '../../models/framesModel'
import { apiFetch } from '../../utils/apiFetch'
import { frameLogic } from '../frame/frameLogic'

interface FrameLocalDeployMenuProps {
  frameId: number
  buttonColor?: DropdownMenuProps['buttonColor']
  buttonClassName?: string
  buttonContent?: ReactNode
  buttonTitle?: string
}

export function FrameLocalDeployMenu({
  frameId,
  buttonColor = 'none',
  buttonClassName,
  buttonContent,
  buttonTitle = 'Frame actions',
}: FrameLocalDeployMenuProps): JSX.Element {
  const { saveFrame } = useActions(frameLogic({ frameId }))
  const { loadFrame, renderFrame, restartFrame } = useActions(framesModel)
  const reloadFrame = async (): Promise<void> => {
    const response = await apiFetch(`/api/frames/${frameId}/reload`, { method: 'POST' })
    if (!response.ok) {
      throw new Error('Failed to reload frame')
    }
    loadFrame(frameId)
  }

  return (
    <DropdownMenu
      buttonColor={buttonColor}
      buttonTitle={buttonTitle}
      buttonContent={
        buttonContent ?? (
          <>
            <ArrowPathIcon className="h-4 w-4 shrink-0" />
            <span>Reload</span>
            <EllipsisHorizontalIcon className="h-4 w-4 shrink-0 opacity-70" />
          </>
        )
      }
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
        buttonClassName
      )}
      items={[
        {
          label: 'Save',
          title: 'Save frame settings and scenes',
          onClick: () => saveFrame(),
          icon: <CloudArrowUpIcon className="h-5 w-5" />,
        },
        {
          label: 'Re-render display',
          title: 'Re-render the current scene',
          onClick: () => renderFrame(frameId),
          icon: <ArrowPathIcon className="h-5 w-5" />,
        },
        {
          label: 'Reload runtime',
          title: 'Reload the saved on-frame configuration and interpreted scenes',
          onClick: () => reloadFrame(),
          icon: <RocketLaunchIcon className="h-5 w-5" />,
        },
        {
          label: 'Restart FrameOS',
          title: 'Restart the on-frame FrameOS runtime',
          onClick: () => restartFrame(frameId),
          icon: <PowerIcon className="h-5 w-5" />,
        },
      ]}
    />
  )
}
