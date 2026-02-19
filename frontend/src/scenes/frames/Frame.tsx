import { A } from 'kea-router'
import { FrameType } from '../../types'
import { H5 } from '../../components/H5'
import { Box } from '../../components/Box'
import { frameHost, frameStatus } from '../../decorators/frame'
import { DropdownMenu } from '../../components/DropdownMenu'
import { ExclamationTriangleIcon, TrashIcon } from '@heroicons/react/24/solid'
import { useActions } from 'kea'
import { framesModel } from '../../models/framesModel'
import { FrameImage } from '../../components/FrameImage'
import { urls } from '../../urls'
import { Tooltip } from '../../components/Tooltip'
import { getFrameCertificateStatus } from '../../utils/certificates'

interface FrameProps {
  frame: FrameType
}

function getTitleAndIcon(enabled: boolean, runCommands: boolean, activeConnections: number): [string, string] {
  if (!enabled) {
    if (activeConnections > 0) {
      return ['FrameOS Agent not enabled, yet connected', '🔵']
    }
    return ['FrameOS Agent not enabled', '']
  }
  if (runCommands) {
    if (activeConnections > 0) {
      return ['FrameOS Agent connected and ready to run commands', '🟢']
    }
    return ['FrameOS Agent not connected', '⚪️']
  }
  if (activeConnections > 0) {
    return ['FrameOS Agent connected, but not configured to run commands', '🟡']
  }
  return ['FrameOS Agent not connected', '⚪️']
}

export function FrameConnection({ frame }: FrameProps): JSX.Element | null {
  const [title, icon] = getTitleAndIcon(
    !!frame.agent?.agentEnabled,
    !!frame.agent?.agentRunCommands,
    frame?.active_connections ?? 0
  )

  if (!icon) {
    return null
  }

  return (
    <Tooltip title={title} className="cursor-help">
      {icon}
    </Tooltip>
  )
}

export function Frame({ frame }: FrameProps): JSX.Element {
  const { deleteFrame } = useActions(framesModel)
  const certificateStatus = getFrameCertificateStatus(frame)

  return (
    <Box id={`frame-${frame.id}`} className="relative">
      <div className="flex gap-2 absolute z-10 right-2 top-2">
        <DropdownMenu
          buttonColor="none"
          items={[
            {
              label: 'Delete',
              onClick: () =>
                window.confirm(`Are you sure you want to delete the frame "${frame.name}"?`) && deleteFrame(frame.id),
              icon: <TrashIcon className="w-5 h-5" />,
            },
          ]}
        />
      </div>
      <A href={urls.frame(frame.id)}>
        <FrameImage frameId={frame.id} className="p-2 m-auto" refreshable={false} />
      </A>
      <div className="flex justify-between px-4 pt-2 mb-2">
        <H5 className="text-ellipsis overflow-hidden flex items-center gap-1">
          <A href={urls.frame(frame.id)}>{frame.name || frameHost(frame)}</A>
          {certificateStatus === 'expiring' || certificateStatus === 'expired' ? (
            <Tooltip
              title={
                certificateStatus === 'expired'
                  ? 'HTTPS certificates have expired, please regenerate and redeploy.'
                  : 'HTTPS certificates expiring soon, please regenerate and redeploy.'
              }
              className="cursor-help"
            >
              <ExclamationTriangleIcon
                className={certificateStatus === 'expired' ? 'h-4 w-4 text-red-300' : 'h-4 w-4 text-yellow-300'}
              />
            </Tooltip>
          ) : null}
        </H5>
      </div>
      <div className="px-4 pb-4">
        <div className="flex sm:text-lg text-gray-400 items-center gap-1">
          <FrameConnection frame={frame} />
          <span>{frameStatus(frame)}</span>
        </div>
      </div>
    </Box>
  )
}
