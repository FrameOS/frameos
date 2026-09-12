import { ArrowDownTrayIcon, ArrowPathIcon, ArrowUpTrayIcon } from '@heroicons/react/24/outline'
import { TrashIcon } from '@heroicons/react/24/solid'
import { DropdownMenu } from '../../../../components/DropdownMenu'
import { downloadJson } from '../../../../utils/objectUrl'
import { parseImportedFrameJson } from '../../../../utils/frameJsonImport'
import { reportTaskOutcome } from '../../../../models/longRunningTasksModel'
import { frameHost } from '../../../../decorators/frame'
import { FRAME_KEYS } from '../../frameLogic'
import { frameDeleteCopy } from '../../../workspace/frameDeleteCopy'
import { useFrameSettings } from './frameSettingsContext'

/**
 * The "…" menu next to the first heading. Import/export are offered
 * everywhere; the build, SD-card and delete entries need a backend that owns
 * the frame, so they are absent on the cloud and inside the frame's own admin
 * panel.
 */
export function FrameActionsMenu(): JSX.Element | null {
  const {
    hideDropdown,
    mode,
    frame,
    surface,
    workspaceSurfaceMode,
    setFrameFormValues,
    openLogs,
    clearBuildCache,
    downloadBuildZip,
    downloadCSourceZip,
    downloadBinaryZip,
    downloadSdCardImage,
    deleteFrame,
    adminLoginIsOnlyAccess,
    buildCacheLoading,
    buildZipLoading,
    cSourceZipLoading,
    binaryZipLoading,
  } = useFrameSettings()

  if (hideDropdown) {
    return null
  }

  const backendOwnsTheFrame = surface === 'backend'

  return (
    <DropdownMenu
      className="w-fit"
      buttonColor="tertiary"
      items={[
        ...(mode === 'rpios' && backendOwnsTheFrame
          ? [
              {
                label: 'Clear build cache on frame',
                onClick: () => {
                  clearBuildCache()
                  openLogs()
                },
                icon: <ArrowPathIcon className="w-5 h-5" />,
                loading: buildCacheLoading,
              },
            ]
          : []),
        ...(mode === 'buildroot' && backendOwnsTheFrame
          ? [
              {
                label: 'Download SD card image',
                onClick: () => downloadSdCardImage(frame.id),
                icon: <ArrowDownTrayIcon className="w-5 h-5" />,
                loading: false,
              },
            ]
          : []),
        {
          label: 'Import frame .json',
          title: 'Load settings from an exported frame .json into this form',
          onClick: () => {
            // The outcome goes to the task toasts, never the console: the
            // file holds every password and key the export wrote.
            const report = (status: 'success' | 'error', fileName: string, detail: string): void =>
              reportTaskOutcome(status, { frameId: frame.id, kind: 'save', title: `Import ${fileName}`, detail })
            function handleFileSelect(event: Event): void {
              const inputElement = event.target as HTMLInputElement
              const file = inputElement.files?.[0]

              if (!file) {
                return
              }

              const reader = new FileReader()

              reader.onload = (loadEvent: ProgressEvent<FileReader>) => {
                try {
                  const { values } = parseImportedFrameJson(String(loadEvent.target?.result ?? ''), FRAME_KEYS)
                  setFrameFormValues(values)
                  report('success', file.name, 'Settings loaded into the form. Review them, then press Save to apply.')
                } catch (error) {
                  report('error', file.name, error instanceof Error ? error.message : 'Could not read the file.')
                }
              }

              reader.onerror = () => {
                report('error', file.name, reader.error?.message ?? 'Could not read the file.')
              }

              reader.readAsText(file)
            }

            const fileInput = document.createElement('input')
            fileInput.type = 'file'
            fileInput.accept = '.json'
            fileInput.addEventListener('change', handleFileSelect)
            fileInput.click()
          },
          icon: <ArrowDownTrayIcon className="w-5 h-5" />,
          loading: false,
        },
        {
          label: 'Export frame .json',
          title: 'Download every setting of this frame, passwords and API keys included',
          onClick: () => {
            downloadJson(frame, `${frame.name || `frame${frame.id}`}.json`)
          },
          icon: <ArrowUpTrayIcon className="w-5 h-5" />,
          loading: false,
        },
        // Build artifacts of a frame the backend compiles for. A frame it
        // reaches only over its admin API runs signed release images: nothing
        // built here could be installed on it, so the entries are not offered
        // (the same silence the cloud keeps).
        ...(backendOwnsTheFrame && !adminLoginIsOnlyAccess
          ? [
              {
                label: 'Download Nim build .zip',
                onClick: () => {
                  downloadBuildZip()
                  openLogs()
                },
                icon: <ArrowUpTrayIcon className="w-5 h-5" />,
                loading: buildZipLoading,
              },
              {
                label: 'Generate C sources .zip',
                onClick: () => {
                  downloadCSourceZip()
                  openLogs()
                },
                icon: <ArrowUpTrayIcon className="w-5 h-5" />,
                loading: cSourceZipLoading,
              },
              {
                label: 'Download built binary .zip',
                onClick: () => {
                  downloadBinaryZip()
                  openLogs()
                },
                icon: <ArrowUpTrayIcon className="w-5 h-5" />,
                loading: binaryZipLoading,
              },
            ]
          : []),
        ...(backendOwnsTheFrame
          ? [
              {
                label: 'Delete frame',
                title: frameDeleteCopy(workspaceSurfaceMode).title,
                confirm: frameDeleteCopy(workspaceSurfaceMode).confirm(frame.name || frameHost(frame)),
                onClick: () => deleteFrame(frame.id),
                icon: <TrashIcon className="w-5 h-5" />,
                loading: false,
              },
            ]
          : []),
      ]}
    />
  )
}
