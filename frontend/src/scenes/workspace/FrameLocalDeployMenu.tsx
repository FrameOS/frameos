import { useActions } from 'kea'
import { ArrowPathIcon, ArrowUturnUpIcon, CloudArrowUpIcon, PowerIcon, RocketLaunchIcon } from '@heroicons/react/24/outline'
import { EllipsisHorizontalIcon } from '@heroicons/react/24/solid'
import clsx from 'clsx'
import type { ReactNode } from 'react'

import { DropdownMenu, type DropdownMenuProps } from '../../components/DropdownMenu'
import { framesModel } from '../../models/framesModel'
import { apiFetch } from '../../utils/apiFetch'
import { frameLogic } from '../frame/frameLogic'
import type { FrameId } from '../../types'

interface FrameLocalDeployMenuProps {
  frameId: FrameId
  buttonColor?: DropdownMenuProps['buttonColor']
  buttonClassName?: string
  buttonContent?: ReactNode
  buttonTitle?: string
  /**
   * Whether Save is one of the entries. The scene sidebar puts "Save &
   * deploy" right next to this menu, so there it is left out.
   */
  includeSave?: boolean
}

/**
 * The on-device admin panel's "…" menu: what a standalone frame can do to
 * itself beyond saving (re-render, reload the runtime, restart FrameOS,
 * reboot the device).
 * Save is what deploys there — the device applies a save as it lands — so
 * this is a plain actions menu, not a second deploy button.
 */
export function FrameLocalDeployMenu({
  frameId,
  buttonColor = 'none',
  buttonClassName,
  buttonContent,
  buttonTitle = 'Frame actions',
  includeSave = true,
}: FrameLocalDeployMenuProps): JSX.Element {
  const { saveFrame } = useActions(frameLogic({ frameId }))
  const { loadFrame, renderFrame, restartFrame, rebootFrame } = useActions(framesModel)
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
      buttonContent={buttonContent ?? <EllipsisHorizontalIcon className="h-5 w-5 shrink-0" />}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
        buttonClassName
      )}
      items={[
        ...(includeSave
          ? [
              {
                label: 'Save',
                title: 'Save frame settings and scenes',
                onClick: () => saveFrame(),
                icon: <CloudArrowUpIcon className="h-5 w-5" />,
              },
            ]
          : []),
        {
          label: 'Re-render',
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
          confirm: 'Restart the FrameOS runtime on this frame?',
          onClick: () => restartFrame(frameId),
          icon: <ArrowUturnUpIcon className="h-5 w-5" />,
        },
        // The device answers POST /api/frames/{id}/reboot with the same
        // `reboot` control event the backend fires on a shell-less frame, so
        // framesModel.rebootFrame needs no on-device special case. Verified
        // from the backend against an adopted card on 2026-09-13.
        {
          label: 'Reboot device',
          title: 'Reboot the whole device, not just FrameOS',
          confirm: 'Reboot this device? The frame goes dark until it boots back up.',
          onClick: () => rebootFrame(frameId),
          icon: <PowerIcon className="h-5 w-5" />,
        },
      ]}
    />
  )
}
