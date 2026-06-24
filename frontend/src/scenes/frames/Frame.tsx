import { A, router } from 'kea-router'
import { FrameType } from '../../types'
import { H5 } from '../../components/H5'
import { Box } from '../../components/Box'
import { frameHost, frameIsHealthy, frameStatus } from '../../decorators/frame'
import { DropdownMenu } from '../../components/DropdownMenu'
import {
  ArchiveBoxIcon,
  ArrowUpCircleIcon,
  ArrowUturnLeftIcon,
  ExclamationTriangleIcon,
  PencilSquareIcon,
  TrashIcon,
} from '@heroicons/react/24/solid'
import { useActions } from 'kea'
import { framesModel } from '../../models/framesModel'
import { FrameImage } from '../../components/FrameImage'
import { FrameConnectionDot } from '../../components/FrameConnectionDot'
import { urls } from '../../urls'
import { Tooltip } from '../../components/Tooltip'
import { getFrameCertificateStatus } from '../../utils/certificates'
import { CURRENT_FRAMEOS_VERSION } from '../frame/frameDeployUtils'

interface FrameProps {
  frame: FrameType
}

interface FrameConnectionProps extends FrameProps {
  title?: string
}

function connectedFrameTitle(enabled: boolean, runCommands: boolean, activeConnections: number): string | null {
  if (activeConnections <= 0) {
    return null
  }

  if (!enabled) {
    return 'FrameOS Remote not enabled, yet connected'
  }
  if (runCommands) {
    return 'FrameOS Remote connected and ready to run commands'
  }
  return 'FrameOS Remote connected, but not configured to run commands'
}

export function FrameConnection({ frame, title: titleOverride }: FrameConnectionProps): JSX.Element | null {
  const title = connectedFrameTitle(
    !!frame.agent?.agentEnabled,
    !!frame.agent?.agentRunCommands,
    frame?.active_connections ?? 0
  )

  if (!title) {
    return null
  }

  return (
    <Tooltip title={titleOverride ?? title} className="cursor-help">
      <FrameConnectionDot title={titleOverride ?? title} />
    </Tooltip>
  )
}

export function FrameHealth({ frame }: FrameProps): JSX.Element | null {
  if (!frameIsHealthy(frame)) {
    return null
  }

  return (
    <Tooltip title="Frame is healthy" className="cursor-help">
      <span className="inline-block h-2.5 w-2.5 rounded-full bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.75)]" />
    </Tooltip>
  )
}

function FrameCardIndicators({ frame }: FrameProps): JSX.Element {
  const agentTitle = connectedFrameTitle(
    !!frame.agent?.agentEnabled,
    !!frame.agent?.agentRunCommands,
    frame?.active_connections ?? 0
  )
  const healthy = frameIsHealthy(frame)

  if (agentTitle) {
    return <FrameConnection frame={frame} title={healthy ? `Frame is healthy. ${agentTitle}.` : agentTitle} />
  }

  return (
    <>
      <FrameHealth frame={frame} />
      <FrameConnection frame={frame} />
    </>
  )
}

export function Frame({ frame }: FrameProps): JSX.Element {
  const { deleteFrame, setFrameArchived } = useActions(framesModel)
  const certificateStatus = getFrameCertificateStatus(frame)
  const deployedFrameOSVersion =
    typeof frame.last_successful_deploy?.frameos_version === 'string'
      ? frame.last_successful_deploy.frameos_version.split('+')[0]
      : null
  const hasFrameOSUpdate = Boolean(deployedFrameOSVersion && deployedFrameOSVersion !== CURRENT_FRAMEOS_VERSION)

  return (
    <Box id={`frame-${frame.id}`} className="relative">
      <div className="flex gap-2 absolute z-10 right-2 top-2">
        <DropdownMenu
          buttonColor="none"
          items={[
            {
              label: 'Edit',
              onClick: () => router.actions.push(urls.frame(frame.id)),
              icon: <PencilSquareIcon className="w-5 h-5" />,
            },
            frame.archived
              ? {
                  label: 'Unarchive',
                  onClick: () => setFrameArchived(frame.id, false),
                  icon: <ArrowUturnLeftIcon className="w-5 h-5" />,
                }
              : {
                  label: 'Archive',
                  onClick: () => setFrameArchived(frame.id, true),
                  icon: <ArchiveBoxIcon className="w-5 h-5" />,
                },
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
          {hasFrameOSUpdate ? (
            <Tooltip title={`FrameOS update available (${deployedFrameOSVersion} -> ${CURRENT_FRAMEOS_VERSION})`}>
              <ArrowUpCircleIcon className="h-4 w-4 text-blue-300" />
            </Tooltip>
          ) : null}
        </H5>
      </div>
      <div className="px-4 pb-4">
        <div className="frameos-muted flex sm:text-lg items-center gap-1">
          <FrameCardIndicators frame={frame} />
          <span>{frameStatus(frame)}</span>
        </div>
      </div>
    </Box>
  )
}
