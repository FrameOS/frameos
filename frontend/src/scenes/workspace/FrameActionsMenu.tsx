import { useActions, useValues } from 'kea'
import type { FormEvent } from 'react'
import {
  ArchiveBoxIcon,
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  CloudArrowDownIcon,
  CommandLineIcon,
  NoSymbolIcon,
  PencilSquareIcon,
  PowerIcon,
  RocketLaunchIcon,
  StopCircleIcon,
  TrashIcon,
} from '@heroicons/react/24/outline'
import { PlayIcon } from '@heroicons/react/24/solid'
import { DropdownMenu, type DropdownMenuProps } from '../../components/DropdownMenu'
import { Modal } from '../../components/Modal'
import { TextInput } from '../../components/TextInput'
import { frameHost } from '../../decorators/frame'
import { framesModel } from '../../models/framesModel'
import type { FrameType } from '../../types'
import { workspaceLogic } from './workspaceLogic'
import {
  frameMenuActionDisabledReason,
  frameMenuActionIsAllowed,
  isEsp32CloudFrame,
  workspaceMode,
  type FrameMenuAction,
} from './workspaceSurfaces'

interface FrameActionsMenuProps {
  frame: FrameType
  archived?: boolean
  className?: string
  buttonColor?: DropdownMenuProps['buttonColor']
}

export function FrameActionsMenu({
  frame,
  archived = frame.archived,
  className,
  buttonColor = 'none',
}: FrameActionsMenuProps): JSX.Element {
  const {
    cancelDeploy,
    deleteFrame,
    deployRemote,
    rebootFrame,
    renderFrame,
    restartRemote,
    restartFrame,
    setFrameArchived,
    stopFrame,
    updateFrameFirmware,
  } = useActions(framesModel)
  const { openFrameChangeDrawer, openRenameFrameDialog } = useActions(workspaceLogic)
  const frameName = frame.name || frameHost(frame)
  const agentConfigured = Boolean(frame.agent?.agentEnabled && frame.agent.agentSharedSecret)
  // Which verbs exist is a property of the control plane, not of this menu —
  // see workspaceSurfaces.ts. Reboot and restart DO exist on the cloud (they
  // are two of its four command verbs); deploys, SSH power actions and
  // backend bookkeeping do not. The frame's device profile never hides an
  // entry — an esp32 cloud frame shows Rename disabled with the reason (it
  // rides the set_settings verb, which that firmware answers
  // `unsupported_verb` for) instead of quietly dropping it. Virtual frames
  // are the exception: device-shaped actions (reboot, stop, SD cards …) are
  // hidden because there is no device — see workspaceSurfaces.ts.
  const mode = workspaceMode()
  const allows = (action: FrameMenuAction): boolean => frameMenuActionIsAllowed(mode, action, frame)
  const disabledReason = (action: FrameMenuAction): string | null =>
    frameMenuActionDisabledReason(mode, action, frame)
  const renameDisabledReason = disabledReason('rename')

  return (
    <DropdownMenu
      buttonColor={buttonColor}
      horizontal
      className={className}
      items={[
        ...(allows('rename')
          ? [
              {
                label: 'Rename',
                title: renameDisabledReason ?? 'Rename frame',
                disabled: Boolean(renameDisabledReason),
                onClick: () => openRenameFrameDialog(frame.id, frameName),
                icon: <PencilSquareIcon className="h-5 w-5" />,
              },
            ]
          : []),
        ...(allows('render')
          ? [
              {
                label: 'Re-render',
                title: 'Render frame now',
                onClick: () => renderFrame(frame.id),
                icon: <PlayIcon className="h-5 w-5" />,
              },
            ]
          : []),
        ...(allows('cancelDeploy') && frame.status === 'deploying'
          ? [
              {
                label: 'Cancel deploy',
                title: 'Abort the running deploy and clear the deploy lock',
                confirm: `Cancel the deploy in progress for "${frameName}"?`,
                onClick: () => cancelDeploy(frame.id),
                icon: <NoSymbolIcon className="h-5 w-5" />,
              },
            ]
          : []),
        ...(allows('deploy')
          ? [
              {
                label: 'Deploy',
                title: 'Open deploy options',
                onClick: () => openFrameChangeDrawer(frame.id, 'deploy'),
                icon: <RocketLaunchIcon className="h-5 w-5" />,
              },
            ]
          : []),
        ...(allows('buildSdCard')
          ? [
              {
                label: 'Build SD card',
                title: 'Build or download a flashable SD card image',
                onClick: () => openFrameChangeDrawer(frame.id, 'deploy', 'sdCard'),
                icon: <ArrowDownTrayIcon className="h-5 w-5" />,
              },
            ]
          : []),
        ...(allows('stop')
          ? [
              {
                label: 'Stop FrameOS',
                title: 'Stop FrameOS service',
                onClick: () => stopFrame(frame.id),
                icon: <StopCircleIcon className="h-5 w-5" />,
              },
            ]
          : []),
        ...(allows('restart')
          ? [
              {
                label: 'Restart FrameOS',
                title: 'Restart the FrameOS runtime',
                onClick: () => restartFrame(frame.id),
                icon: <ArrowPathIcon className="h-5 w-5" />,
              },
            ]
          : []),
        ...(allows('reboot')
          ? [
              {
                label: 'Reboot device',
                title: 'Reboot device',
                onClick: () => rebootFrame(frame.id),
                icon: <PowerIcon className="h-5 w-5" />,
              },
            ]
          : []),
        // Firmware-shaped on purpose: only esp32 cloud frames get the entry —
        // a Pi cloud frame has no firmware image to swap (its update path is
        // the buildroot release flow, not yet cloud-nudgeable), so an
        // always-disabled button would explain nothing. The capability check
        // still rides menuActionCapabilities (updateNotify) for the day a
        // profile lags behind the verb again.
        ...(allows('updateFirmware') && isEsp32CloudFrame(frame)
          ? [
              {
                label: 'Update firmware',
                title:
                  disabledReason('updateFirmware') ??
                  'Ask the frame to check for new firmware and install it in the background',
                disabled: Boolean(disabledReason('updateFirmware')),
                onClick: () => updateFrameFirmware(frame.id),
                icon: <CloudArrowDownIcon className="h-5 w-5" />,
              },
            ]
          : []),
        ...(allows('restartRemote') && agentConfigured
          ? [
              {
                label: 'Restart Remote',
                title: 'Restart FrameOS Remote',
                onClick: () => restartRemote(frame.id),
                icon: <CommandLineIcon className="h-5 w-5" />,
              },
            ]
          : []),
        ...(allows('deployRemote') && agentConfigured
          ? [
              {
                label: 'Deploy Remote',
                title: 'Deploy FrameOS Remote',
                onClick: () => deployRemote(frame.id),
                icon: <CommandLineIcon className="h-5 w-5" />,
              },
            ]
          : []),
        ...(allows('archive')
          ? [
              {
                label: archived ? 'Restore' : 'Archive',
                title: archived ? 'Restore frame' : 'Archive frame',
                onClick: () => setFrameArchived(frame.id, !archived),
                icon: archived ? <ArrowUturnLeftIcon className="h-5 w-5" /> : <ArchiveBoxIcon className="h-5 w-5" />,
              },
            ]
          : []),
        ...(allows('delete')
          ? [
              {
                label: 'Delete',
                title: 'Delete frame',
                confirm: `Delete "${frameName}"? This cannot be undone.`,
                onClick: () => deleteFrame(frame.id),
                icon: <TrashIcon className="h-5 w-5" />,
              },
            ]
          : []),
      ]}
    />
  )
}

export function FrameRenameModal(): JSX.Element | null {
  const { renameFrameDialog } = useValues(workspaceLogic)
  const { frames } = useValues(framesModel)
  const { closeRenameFrameDialog, setRenameFrameName } = useActions(workspaceLogic)
  const { renameFrame } = useActions(framesModel)

  if (!renameFrameDialog) {
    return null
  }

  const frame = frames[renameFrameDialog.frameId]
  if (!frame) {
    return null
  }

  const frameName = frame.name || frameHost(frame)
  const nextName = renameFrameDialog.name.trim()
  const canSave = nextName.length > 0 && nextName !== frameName

  const submitRename = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!canSave) {
      return
    }
    renameFrame(frame.id, nextName)
    closeRenameFrameDialog()
  }

  return (
    <Modal open onClose={closeRenameFrameDialog} title="Rename frame">
      <form onSubmit={submitRename} className="space-y-4 p-5">
        <label className="block">
          <span className="frameos-muted mb-2 block text-sm font-semibold">Frame name</span>
          <TextInput autoFocus value={renameFrameDialog.name} onChange={setRenameFrameName} />
        </label>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={closeRenameFrameDialog}
            className="frameos-secondary-button rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSave}
            className="frameos-primary-action rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Rename
          </button>
        </div>
      </form>
    </Modal>
  )
}
