import { CommandLineIcon, StopCircleIcon } from '@heroicons/react/24/outline'
import { useActions, useValues } from 'kea'

import { Spinner } from '../../components/Spinner'
import {
  embeddedUsbLogsModel,
  isEmbeddedUsbLogStreamOpen,
  startEmbeddedUsbLogStream,
} from '../../models/embeddedUsbLogsModel'
import type { FrameType } from '../../types'
import { workspaceLogic } from './workspaceLogic'

// The frame's "Connect USB" button: its USB log stream, opened behind the
// Logs panel.

function usbConnectionButtonLabel(
  usbLogStreamState: { status?: string } | undefined,
  usbLogStreamOpen: boolean
): string {
  return usbLogStreamState?.status === 'selecting'
    ? 'Select USB port'
    : usbLogStreamState?.status === 'connecting'
      ? 'Connecting USB'
      : usbLogStreamState?.status === 'stopping'
        ? 'Disconnecting USB'
        : usbLogStreamOpen
          ? 'Disconnect USB'
          : 'Connect USB'
}

export function EmbeddedUsbConnectionButton({
  frame,
  disabled = false,
  className = '',
}: {
  frame: FrameType
  disabled?: boolean
  className?: string
}): JSX.Element {
  const { openFrameToolBehindDrawer } = useActions(workspaceLogic)
  const { stopUsbLogStream } = useActions(embeddedUsbLogsModel)
  const { usbLogStreamStatesByFrameId } = useValues(embeddedUsbLogsModel)
  const usbLogStreamState = usbLogStreamStatesByFrameId[frame.id]
  const usbLogStreamOpen = isEmbeddedUsbLogStreamOpen(usbLogStreamState)
  const usbLogStreamBusy =
    usbLogStreamState?.status === 'selecting' ||
    usbLogStreamState?.status === 'connecting' ||
    usbLogStreamState?.status === 'stopping'

  const connectUsb = async (): Promise<void> => {
    const started = await startEmbeddedUsbLogStream(frame.id)
    if (started) {
      openFrameToolBehindDrawer(frame.id, 'logs')
    }
  }

  return (
    <button
      type="button"
      onClick={usbLogStreamOpen ? () => stopUsbLogStream(frame.id) : connectUsb}
      disabled={disabled || usbLogStreamBusy}
      className={`frameos-secondary-button inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40 ${className}`}
    >
      {usbLogStreamState?.status === 'selecting' || usbLogStreamState?.status === 'connecting' ? (
        <Spinner />
      ) : usbLogStreamOpen ? (
        <StopCircleIcon className="h-4 w-4" />
      ) : (
        <CommandLineIcon className="h-4 w-4" />
      )}
      {usbConnectionButtonLabel(usbLogStreamState, usbLogStreamOpen)}
    </button>
  )
}
