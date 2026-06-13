import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import equal from 'fast-deep-equal'
import { Button } from '../../../../components/Button'
import { framesModel } from '../../../../models/framesModel'
import { Form, Group } from 'kea-forms'
import { TextInput } from '../../../../components/TextInput'
import { Select } from '../../../../components/Select'
import { frameAdminUrl, frameControlUrl, frameImageUrl, frameRootUrl, frameUrl } from '../../../../decorators/frame'
import {
  DEFAULT_FRAME_ERROR_BEHAVIOR,
  DEFAULT_TIMEZONE_UPDATE_HOUR,
  DEFAULT_TIMEZONE_UPDATE_URL,
  frameLogic,
  normalizeFrameErrorBehavior,
} from '../../frameLogic'
import { frameCompilationModeOptions, frameCrossCompilationOptions } from '../../../../utils/frameBuildOptions'
import { downloadJson } from '../../../../utils/downloadJson'
import { Field } from '../../../../components/Field'
import {
  devices,
  spectraPalettes,
  withCustomPalette,
  buildrootPlatforms,
  embeddedPlatforms,
  EMBEDDED_ESP32_S3,
  modes,
} from '../../../../devices'
import { secureToken } from '../../../../utils/secureToken'
import { appsLogic } from '../Apps/appsLogic'
import { frameSettingsLogic } from './frameSettingsLogic'
import { Spinner } from '../../../../components/Spinner'
import { H6 } from '../../../../components/H6'
import { DropdownMenu } from '../../../../components/DropdownMenu'
import { ArrowDownTrayIcon, ArrowPathIcon, ArrowUpTrayIcon } from '@heroicons/react/24/outline'
import { ExclamationTriangleIcon, PlusIcon, TrashIcon } from '@heroicons/react/24/solid'
import { workspaceLogic } from '../../../workspace/workspaceLogic'
import { Switch } from '../../../../components/Switch'
import { NumberTextInput } from '../../../../components/NumberTextInput'
import { FrameErrorBehaviorMode, FrameMountpointConfig, FrameType, Palette } from '../../../../types'
import { A } from 'kea-router'
import { TextArea } from '../../../../components/TextArea'
import { ColorInput } from '../../../../components/ColorInput'
import { settingsLogic } from '../../../settings/settingsLogic'
import { isInFrameAdminMode } from '../../../../utils/frameAdmin'
import { normalizeSshKeys } from '../../../../utils/sshKeys'
import { Label } from '../../../../components/Label'
import { logsLogic } from '../Logs/logsLogic'
import { Tag } from '../../../../components/Tag'
import { getCertificateValidityInfo, getFrameCertificateStatus } from '../../../../utils/certificates'
import { timezoneOptions } from '../../../../decorators/timezones'
import { Tooltip } from '../../../../components/Tooltip'

export interface FrameSettingsProps {
  className?: string
  hideDropdown?: boolean
  hideDeploymentMode?: boolean
  scrollContainer?: boolean
}

function getCertificateHint(certificateName: string, value?: string): JSX.Element | undefined {
  const validityInfo = getCertificateValidityInfo(value)

  if (!validityInfo) {
    return undefined
  }

  const colorClass =
    validityInfo.severity === 'expired'
      ? 'text-red-300'
      : validityInfo.severity === 'expiring'
      ? 'text-yellow-300'
      : 'frame-tool-muted'

  return (
    <div className={colorClass} title={validityInfo.exactDateTime}>
      {(validityInfo.severity === 'expired' || validityInfo.severity === 'expiring') && (
        <ExclamationTriangleIcon
          className={
            validityInfo.severity === 'expired'
              ? 'inline-block mr-1 h-4 w-4 text-red-300'
              : 'inline-block mr-1 h-4 w-4 text-yellow-300'
          }
        />
      )}
      {certificateName} {validityInfo.humanText}
      {validityInfo.severity === 'expired' || validityInfo.severity === 'expiring'
        ? ' - Please regenerate and redeploy.'
        : ''}
    </div>
  )
}

function CertificateTriangle({
  frame,
  frameForm,
}: {
  frame: FrameType | null
  frameForm: Partial<FrameType> | null
}): JSX.Element | null {
  const certificateStatus = getFrameCertificateStatus({
    https_proxy: {
      client_ca_cert_not_valid_after:
        frameForm?.https_proxy?.client_ca_cert_not_valid_after ?? frame?.https_proxy?.client_ca_cert_not_valid_after,
      server_cert_not_valid_after:
        frameForm?.https_proxy?.server_cert_not_valid_after ?? frame?.https_proxy?.server_cert_not_valid_after,
    },
  })
  if (certificateStatus !== 'expired' && certificateStatus !== 'expiring') {
    return null
  }
  return (
    <span
      title={
        certificateStatus === 'expired'
          ? 'HTTPS certificates have expired. Please regenerate and redeploy.'
          : 'HTTPS certificates are expiring soon. Please regenerate and redeploy.'
      }
    >
      <ExclamationTriangleIcon
        className={certificateStatus === 'expired' ? 'h-4 w-4 text-red-300' : 'h-4 w-4 text-yellow-300'}
      />
    </span>
  )
}

function newMountpoint(): FrameMountpointConfig {
  return {
    enabled: true,
    source: '',
    target: '',
    username: '',
    password: '',
    domain: '',
    options: 'vers=3.0',
  }
}

function scrollToFrameHttpApiSection(e: React.MouseEvent): void {
  if (typeof document === 'undefined') {
    return
  }
  const frameSettingsDiv =
    e.target instanceof HTMLElement
      ? e.target.closest('#panel-settings-div')
      : document.getElementById('panel-settings-div')
  const scrollingOuterDiv = frameSettingsDiv?.parentElement
  const httpApiSection = frameSettingsDiv?.querySelector('#frame-http-proxy-section')
  if (scrollingOuterDiv && httpApiSection) {
    const offset = httpApiSection.getBoundingClientRect().top - scrollingOuterDiv.getBoundingClientRect().top
    scrollingOuterDiv.scrollTo({ top: offset, behavior: 'smooth' }) // works in frame settings panel
    scrollingOuterDiv?.parentElement?.scrollTo({ top: offset, behavior: 'smooth' }) // works in sd card modal
  }
}

export function FrameSettings({
  className,
  hideDropdown,
  hideDeploymentMode,
  scrollContainer = true,
}: FrameSettingsProps) {
  const { mode, frameId, frame, frameForm, frameFormTouches } = useValues(frameLogic)
  const {
    touchFrameFormField,
    setFrameFormValues,
    updateDeployedSshKeys,
    generateFrameAdminCredentials,
    generateTlsCertificates,
    verifyTlsCertificates,
  } = useActions(frameLogic)
  const { deleteFrame, downloadSdCardImage } = useActions(framesModel)
  const { appsWithSaveAssets } = useValues(appsLogic({ frameId }))
  const { clearBuildCache, downloadBuildZip, downloadCSourceZip, downloadBinaryZip } = useActions(
    frameSettingsLogic({ frameId })
  )
  const { buildCacheLoading, buildZipLoading, cSourceZipLoading, binaryZipLoading } = useValues(
    frameSettingsLogic({ frameId })
  )
  const { openFrameTool } = useActions(workspaceLogic)
  const openLogs = () => openFrameTool(frameId, 'logs')
  const { logs, ipAddresses } = useValues(logsLogic({ frameId }))
  const { savedSettings } = useValues(settingsLogic)
  const tlsEnabled = !!(frameForm.https_proxy?.enable ?? frame.https_proxy?.enable)
  const inFrameAdminMode = isInFrameAdminMode()

  const palette = withCustomPalette[frame.device || '']
  const inkyAutoButtonDevice = [
    'pimoroni.inky_impression',
    'pimoroni.inky_impression_7_3',
    'pimoroni.inky_impression_7_color',
    'pimoroni.inky_impression_5_7',
    'pimoroni.inky_impression_5_7_color',
    'pimoroni.inky_impression_4_7_color',
    'pimoroni.inky_impression_4',
    'pimoroni.inky_impression_4_2025',
    'pimoroni.inky_impression_4_spectra6',
    'pimoroni.inky_impression_7',
    'pimoroni.inky_impression_7_2025',
    'pimoroni.inky_impression_13',
    'pimoroni.inky_impression_13_2025',
  ].includes(frameForm.device || '')
  const inkyThirteenDevice = ['pimoroni.inky_impression_13', 'pimoroni.inky_impression_13_2025'].includes(
    frameForm.device || ''
  )
  const sshKeyOptions = normalizeSshKeys(savedSettings?.ssh_keys).keys
  const normalizeKeyIds = (keys: string[]) => Array.from(new Set(keys)).sort()
  const deployedSshKeyIds = normalizeKeyIds(
    (frame.last_successful_deploy?.ssh_keys as string[]) ?? frame.ssh_keys ?? []
  )
  const selectedSshKeyIds = normalizeKeyIds(frameForm.ssh_keys ?? frame.ssh_keys ?? [])
  const hasSshKeyChangesToDeploy = !equal(deployedSshKeyIds, selectedSshKeyIds)
  const showFrameInfo = !!frame.frame_host || (!inFrameAdminMode && logs.length > 0)
  const mountpoints = frameForm.mountpoints ?? { enabled: false, items: [] }
  const mountpointItems = mountpoints.items ?? []
  const errorBehavior = normalizeFrameErrorBehavior(frameForm.error_behavior ?? frame.error_behavior)
  const isBuildrootMode = mode === 'buildroot'
  const isEmbeddedMode = mode === 'embedded'
  const showWifiCredentials = isBuildrootMode || isEmbeddedMode
  const selectedTimezone = frameForm.timezone ?? frame.timezone ?? ''
  const timezoneUpdater = frameForm.timezone_updater ?? {}
  const timezoneUpdateHourValue =
    typeof timezoneUpdater.hour === 'number' && Number.isInteger(timezoneUpdater.hour)
      ? String(timezoneUpdater.hour)
      : ''
  const timezoneUpdateUrlValue = timezoneUpdater.url ?? ''
  const setTimezoneUpdaterValue = (patch: Partial<NonNullable<FrameType['timezone_updater']>>) => {
    const next = {
      ...timezoneUpdater,
      ...patch,
    }
    if (next.hour === undefined) {
      delete next.hour
    }
    if (!next.url) {
      delete next.url
    }
    setFrameFormValues({ timezone_updater: next })
  }
  const setTimezoneUpdateHour = (rawValue: string) => {
    const value = rawValue.trim()
    if (!value) {
      setTimezoneUpdaterValue({ hour: undefined })
      return
    }
    if (!/^\d+$/.test(value)) {
      return
    }
    const hour = Number(value)
    if (hour >= 0 && hour <= 23) {
      setTimezoneUpdaterValue({ hour })
    }
  }
  const baseTimezoneOptions =
    mode === 'rpios' ? [{ value: '', label: 'Detect from frame' }, ...timezoneOptions] : timezoneOptions
  const frameTimezoneOptions =
    selectedTimezone && !baseTimezoneOptions.some((option) => option.value === selectedTimezone)
      ? [{ value: selectedTimezone, label: `${selectedTimezone} (detected)` }, ...baseTimezoneOptions]
      : baseTimezoneOptions
  const setErrorBehavior = (patch: Partial<NonNullable<FrameType['error_behavior']>>) => {
    setFrameFormValues({
      error_behavior: normalizeFrameErrorBehavior({
        ...errorBehavior,
        ...patch,
      }),
    })
  }
  const errorBehaviorModes: { value: FrameErrorBehaviorMode; title: string; description: string }[] = [
    {
      value: 'safe_mode',
      title: 'Fail hard',
      description: 'Restart through the service manager and let Boot Guard enter safe mode after repeated crashes.',
    },
    {
      value: 'show_error_retry',
      title: 'Show error, then retry',
      description: 'Render the fatal error on the frame, wait, then try to start FrameOS again.',
    },
    {
      value: 'silent_retry',
      title: 'Retry silently first',
      description: 'Keep the current image while retrying, optionally switching to the visible error screen later.',
    },
  ]
  const setMountpoints = (nextMountpoints: NonNullable<FrameType['mountpoints']>) => {
    setFrameFormValues({ mountpoints: nextMountpoints })
    touchFrameFormField('mountpoints')
  }
  const addMountpoint = () => {
    setMountpoints({
      ...mountpoints,
      enabled: true,
      items: [...mountpointItems, newMountpoint()],
    })
  }
  const removeMountpoint = (index: number) => {
    setMountpoints({
      ...mountpoints,
      items: mountpointItems.filter((_, itemIndex) => itemIndex !== index),
    })
  }

  if (!frame) {
    return (
      <div className={className}>
        Loading frame {frameId}...
        <Spinner />
      </div>
    )
  }

  const linkFrame: FrameType = {
    ...frame,
    frame_access: frameForm.frame_access ?? frame.frame_access,
    frame_access_key: frameForm.frame_access_key ?? frame.frame_access_key,
    frame_admin_auth: {
      ...(frame.frame_admin_auth ?? {}),
      ...(frameForm.frame_admin_auth ?? {}),
    },
  }
  const url = frameUrl(linkFrame)
  const controlUrl = frameControlUrl(linkFrame)
  const adminUrl = frameAdminUrl(linkFrame)
  const imageUrl = frameImageUrl(linkFrame)
  const frameActionsMenu = hideDropdown ? null : (
    <DropdownMenu
      className="w-fit"
      buttonColor="tertiary"
      items={[
        ...(mode === 'rpios' && !inFrameAdminMode
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
        ...(mode === 'buildroot' && !inFrameAdminMode
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
          onClick: () => {
            function handleFileSelect(event: Event): void {
              const inputElement = event.target as HTMLInputElement
              const file = inputElement.files?.[0]

              if (!file) {
                console.error('No file selected')
                return
              }

              const reader = new FileReader()

              reader.onload = (loadEvent: ProgressEvent<FileReader>) => {
                try {
                  const jsonData = JSON.parse(loadEvent.target?.result as string)
                  const { id, ...rest } = jsonData
                  setFrameFormValues(rest)
                  console.log('Imported frame:', jsonData)
                  console.log('Press SAVE now to save the imported frame')
                } catch (error) {
                  console.error('Error parsing JSON:', error)
                }
              }

              reader.onerror = () => {
                console.error('Error reading file:', reader.error)
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
          onClick: () => {
            downloadJson(frame, `${frame.name || `frame${frame.id}`}.json`)
          },
          icon: <ArrowUpTrayIcon className="w-5 h-5" />,
          loading: false,
        },
        ...(!inFrameAdminMode
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
              {
                label: 'Delete frame',
                onClick: () => {
                  if (confirm('Are you sure you want to DELETE this frame?')) {
                    deleteFrame(frame.id)
                  }
                },
                icon: <TrashIcon className="w-5 h-5" />,
                loading: false,
              },
            ]
          : []),
      ]}
    />
  )

  return (
    <div
      className={clsx(
        'frame-tool-panel frame-settings-panel',
        scrollContainer ? 'h-full overflow-y-auto pr-2' : 'overflow-visible',
        className
      )}
      id="panel-settings-div"
    >
      <Form
        formKey="frameForm"
        logic={frameLogic}
        props={{ frameId }}
        className="space-y-4 @container"
        enableFormOnSubmit
      >
        {showFrameInfo ? (
          <>
            <div className="frame-settings-heading-row mt-2 flex items-center justify-between gap-3">
              <H6 id="frame-settings-info">Frame info</H6>
              {frameActionsMenu}
            </div>
            <div className="pl-2 @md:pl-8 space-y-2">
              {frame.frame_host ? (
                <Field
                  name="_noop"
                  label="Load directly"
                  tooltip={`Open URLs for this frame directly in the browser. Loads ${frameRootUrl(frame)}`}
                >
                  <div className="w-full flex flex-wrap gap-2 items-center">
                    <A href={url} target="_blank" rel="noreferrer noopener" className="frameos-link hover:underline">
                      Frame URL
                    </A>
                    <A
                      href={controlUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="frameos-link hover:underline"
                    >
                      Control URL
                    </A>
                    {adminUrl ? (
                      <A
                        href={adminUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="frameos-link hover:underline"
                      >
                        Admin URL
                      </A>
                    ) : null}
                    <A
                      href={imageUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="frameos-link hover:underline"
                    >
                      Image URL
                    </A>
                    <button
                      type="button"
                      onClick={scrollToFrameHttpApiSection}
                      className="cursor-pointer"
                      aria-label="Jump to HTTP API on frame settings"
                    >
                      <Tag color={tlsEnabled ? 'primary' : 'gray'} className="flex gap-1">
                        {tlsEnabled ? 'HTTPS enabled' : 'HTTPS disabled'}
                        <CertificateTriangle frame={frame} frameForm={frameForm} />
                      </Tag>
                    </button>
                  </div>
                </Field>
              ) : null}
              {!inFrameAdminMode && logs.length > 0 ? (
                <Field name="_noop" label="Last seen IPs">
                  <div className="frameos-strong text-sm break-words w-full">
                    {ipAddresses.length > 0 ? ipAddresses.join(', ') : 'No logs have been sent for the frame yet.'}
                  </div>
                </Field>
              ) : null}
            </div>
          </>
        ) : null}
        {showFrameInfo ? (
          <H6 id="frame-settings-device" className="mt-2">
            Device settings
          </H6>
        ) : (
          <div className="frame-settings-heading-row mt-2 flex items-center justify-between gap-3">
            <H6 id="frame-settings-device">Device settings</H6>
            {frameActionsMenu}
          </div>
        )}
        <div className="pl-2 @md:pl-8 space-y-2">
          <Field name="name" label="Name">
            <TextInput name="name" placeholder="Hallway frame" required />
          </Field>
          {!hideDeploymentMode ? (
            <Field name="mode" label="Deployment mode">
              {({ value, onChange }) => (
                <Select
                  name="mode"
                  value={(value as string) || 'rpios'}
                  options={modes}
                  disabled={inFrameAdminMode}
                  onChange={(nextMode) => {
                    onChange(nextMode)
                    if (nextMode === 'embedded' && !frameForm.embedded?.platform) {
                      setFrameFormValues({
                        embedded: { ...(frameForm.embedded ?? {}), platform: EMBEDDED_ESP32_S3 },
                      })
                    }
                  }}
                />
              )}
            </Field>
          ) : null}
          <Field name="device" label="Display driver">
            <Select name="device" options={devices} />
          </Field>
          {frameForm.device === 'waveshare.EPD_10in3' ? (
            <Group name="device_config">
              <Field name="vcom" label="VCOM">
                <TextInput name="vcom" placeholder="-1.48" required />
              </Field>
            </Group>
          ) : null}
          {frameForm.device === 'http.upload' ? (
            <div className="">
              <Group name="device_config">
                <Field
                  name="uploadUrl"
                  label="Upload URL"
                  tooltip="Upload the rendered image here as PNG in the POST body. Only upload when the image changes."
                >
                  {({ value, onChange }) => (
                    <TextInput
                      value={(value as string) ?? ''}
                      onChange={onChange}
                      placeholder="https://example.com/upload"
                      required
                    />
                  )}
                </Field>
                <Field
                  name="uploadHeaders"
                  label="HTTP headers"
                  tooltip="Optional headers (for example Authorization) to send with every upload."
                >
                  {({ value, onChange }) => {
                    const headers = Array.isArray(value) ? [...value] : []
                    const updateHeader = (index: number, key: 'name' | 'value', newValue: string) => {
                      const next = headers.map((header: { name?: string; value?: string }, idx: number) =>
                        idx === index
                          ? { name: header?.name ?? '', value: header?.value ?? '', [key]: newValue }
                          : header
                      )
                      onChange(next)
                    }
                    const addHeader = () => onChange([...headers, { name: '', value: '' }])
                    const removeHeader = (index: number) => {
                      onChange(headers.filter((_: unknown, idx: number) => idx !== index))
                    }
                    return (
                      <div className="space-y-2">
                        {headers.map((header: { name?: string; value?: string }, index: number) => (
                          <div key={index} className="flex flex-col gap-2 @md:flex-row @md:items-center">
                            <TextInput
                              value={header?.name ?? ''}
                              onChange={(val) => updateHeader(index, 'name', val)}
                              placeholder="Header name"
                            />
                            <TextInput
                              value={header?.value ?? ''}
                              onChange={(val) => updateHeader(index, 'value', val)}
                              placeholder="Header value"
                            />
                            <Button color="gray" size="small" onClick={() => removeHeader(index)}>
                              Remove
                            </Button>
                          </div>
                        ))}
                        <Button color="secondary" size="small" onClick={addHeader}>
                          Add header
                        </Button>
                      </div>
                    )
                  }}
                </Field>
              </Group>
            </div>
          ) : null}
          {isBuildrootMode ? (
            <Group name="buildroot">
              <Field name="platform" label="Platform">
                <Select name="buildroot.platform" options={buildrootPlatforms} />
              </Field>
              <Field
                name="compilationMode"
                label="Compilation mode"
                tooltip={
                  <div className="space-y-2">
                    <p>
                      Choose whether the SD image uses a published FrameOS release or compiles this checkout for the
                      image.
                    </p>
                    <p>
                      Use a build mode when testing local development changes that are not in a published release yet.
                    </p>
                  </div>
                }
              >
                <Select name="buildroot.compilationMode" options={frameCompilationModeOptions} />
              </Field>
            </Group>
          ) : null}
          {isEmbeddedMode ? (
            <Group name="embedded">
              <Field name="platform" label="Platform">
                <Select name="embedded.platform" options={embeddedPlatforms} />
              </Field>
            </Group>
          ) : null}
          {/* {frameForm.mode === 'rpios' || !frameForm.mode ? (
            <Group name="rpios">
              <Field name="platform" label="Platform">
                <Select name="rpios.platform" options={rpiOSPlatforms} />
              </Field>
            </Group>
          ) : null} */}
          <Field name="rotate" label="Rotation">
            {({ value, onChange }) => (
              <Select
                value={value || '0'}
                onChange={(v) => onChange(parseInt(v))}
                name="rotate"
                options={[
                  { value: 0, label: '0 degrees' },
                  { value: 90, label: '90 degrees' },
                  { value: 180, label: '180 degrees' },
                  { value: 270, label: '270 degrees' },
                ]}
              />
            )}
          </Field>
          <Field name="flip" label="Flip">
            {({ value, onChange }) => (
              <Select
                value={value || ''}
                onChange={(v) => onChange(v)}
                name="flip"
                options={[
                  { value: '', label: '-' },
                  { value: 'horizontal', label: 'horizontal' },
                  { value: 'vertical', label: 'vertical' },
                  { value: 'both', label: 'both' },
                ]}
              />
            )}
          </Field>
          {(!inFrameAdminMode && frameForm.mode === 'rpios') || (!inFrameAdminMode && !frameForm.mode) ? (
            <Group name="rpios">
              <Field
                name="crossCompilation"
                label="Cross compilation"
                tooltip={
                  <div className="space-y-2">
                    <p>
                      Choose how to build the FrameOS binary: auto follows the build environment selected in global
                      settings, always fails if server-side compilation is disabled or unavailable, and never always
                      builds on the device.
                    </p>
                    <p>Configure Docker, a build host, or Modal sandboxes from global settings.</p>
                  </div>
                }
              >
                <Select name="rpios.crossCompilation" options={frameCrossCompilationOptions} />
              </Field>
              <Field
                name="compilationMode"
                label="Compilation mode"
                tooltip={
                  <div className="space-y-2">
                    <p>
                      Choose whether display/input drivers are shared libraries, or if compiled scenes are bundled in a
                      single shared library, or linked directly into the FrameOS executable.
                    </p>
                    <p>
                      Precompiled downloads a published FrameOS release when all scenes are interpreted; otherwise it
                      will fall back to a shared scenes library when compiled scenes exist, or a single executable
                      otherwise.
                    </p>
                  </div>
                }
              >
                <Select name="rpios.compilationMode" options={frameCompilationModeOptions} />
              </Field>
            </Group>
          ) : null}
          <Field name="debug" label="Debug mode (noisy)">
            <Select
              name="debug"
              options={[
                { value: 'false', label: 'Disabled' },
                { value: 'true', label: 'Enabled' },
              ]}
            />
          </Field>
          {mode === 'buildroot' || mode === 'rpios' ? (
            <Field
              name="timezone"
              label="Timezone"
              tooltip={
                mode === 'buildroot'
                  ? 'IANA timezone applied to the Buildroot operating system during setup.'
                  : 'IANA timezone applied to Raspberry Pi OS during setup. Leave unchanged to keep a detected timezone.'
              }
            >
              <Select name="timezone" options={frameTimezoneOptions} />
            </Field>
          ) : null}
        </div>

        {!inFrameAdminMode ? (
          <>
            <H6 id="frame-settings-ssh" className="mt-2">
              {isEmbeddedMode ? (
                <>Frame host</>
              ) : (
                <>
                  SSH <span className="text-gray-500">(backend &#8594; frame)</span>
                </>
              )}
            </H6>
            <div className="pl-2 @md:pl-8 space-y-2">
              <Field
                name="frame_host"
                label="Frame host"
                tooltip={
                  <div className="space-y-2">
                    {isEmbeddedMode ? (
                      <>
                        <p>
                          The hostname to bake into the ESP32 firmware. A value like frame.local sets the device
                          hostname to frame.
                        </p>
                        <p>Leave it blank to use the generated frame hostname.</p>
                      </>
                    ) : (
                      <>
                        <p>The hostname or IP address that the backend uses to connect to the frame for SSH and HTTP.</p>
                        <p>You can leave it blank if you only use the FrameOS agent to communicate.</p>
                      </>
                    )}
                  </div>
                }
              >
                <TextInput name="frame_host" placeholder={`frame${frame.id}.local`} required />
              </Field>
              {!isEmbeddedMode ? (
                <>
                  <Field name="ssh_user" label="SSH user">
                    <TextInput name="ssh_user" placeholder="pi" required />
                  </Field>
                  <Field
                    name="ssh_pass"
                    label="SSH pass"
                    tooltip={
                      <p>
                        Leave empty to use a SSH key. Configure it under{' '}
                        <A href="/settings" className="frameos-link hover:underline">
                          global settings.
                        </A>
                      </p>
                    }
                  >
                    <TextInput
                      name="ssh_pass"
                      onClick={() => touchFrameFormField('ssh_pass')}
                      type={frameFormTouches.ssh_pass ? 'text' : 'password'}
                      placeholder="no password, using SSH key"
                    />
                  </Field>
                  <Field name="ssh_port" label="SSH port">
                    <TextInput name="ssh_port" placeholder="22" required />
                  </Field>
                  <div className="@md:flex @md:gap-2">
                    <Label className="@md:w-1/3">SSH Keys</Label>
                    <div className="w-full space-y-2">
                      {sshKeyOptions.length === 0 ? (
                        <div className="text-sm text-gray-500">No SSH keys configured in settings.</div>
                      ) : (
                        <div className="space-y-2">
                          {sshKeyOptions.map((key) => {
                            const selectedKeys = new Set(frameForm.ssh_keys ?? frame.ssh_keys ?? [])
                            return (
                              <div key={key.id} className="flex flex-row gap-2">
                                <Switch
                                  value={selectedKeys.has(key.id)}
                                  onChange={(value) => {
                                    const next = new Set(selectedKeys)
                                    if (value) {
                                      next.add(key.id)
                                    } else {
                                      next.delete(key.id)
                                    }
                                    setFrameFormValues({ ssh_keys: Array.from(next) })
                                  }}
                                />
                                <div className="text-sm">{key.name || key.id}</div>
                                {key.use_for_new_frames ? (
                                  <div className="text-xs text-gray-500">Default for new frames</div>
                                ) : null}
                              </div>
                            )
                          })}
                        </div>
                      )}
                      {mode === 'rpios' ? (
                        <div className="flex gap-2">
                          <Button
                            size="small"
                            color={hasSshKeyChangesToDeploy ? 'primary' : 'secondary'}
                            onClick={() => {
                              updateDeployedSshKeys()
                              openLogs()
                            }}
                            disabled={(frameForm.ssh_keys ?? frame.ssh_keys ?? []).length === 0}
                          >
                            Save changes & update deployed keys
                          </Button>
                        </div>
                      ) : null}
                      <p className="text-xs text-gray-500">
                        At least one previously installed key must remain when updating deployed keys.
                      </p>
                    </div>
                  </div>
                </>
              ) : null}
            </div>

            {!isEmbeddedMode ? (
              <>
                <H6 id="frame-settings-agent">
                  Agent (beta) <span className="text-gray-500">(frame &#8594; backend &#8594; frame)</span>
                </H6>
                <div className="pl-2 @md:pl-8 space-y-2">
                  <Group name="agent">
                    <Field
                      name="agentEnabled"
                      label="Agent enabled"
                      tooltip={
                        <div className="space-y-2">
                          <p>
                            The FrameOS Agent opens a websocket connection from the frame to the backend, which is then
                            used by the backend to control the frame. This allows you to control the frame even if it's
                            behind a firewall. The backend must be publicly accessible for this to work.
                          </p>
                          <p>
                            This is still beta. Enable both toggles, then save and deploy the frame. The agent will then
                            connect to the backend to await further commands.
                          </p>
                          <p>
                            Note: after enabling the agent, you must manually deploy it from the "..." -&gt; "Deploy
                            Agent" menu in the top.
                          </p>
                        </div>
                      }
                    >
                      <Switch name="agentEnabled" fullWidth />
                    </Field>
                    {frameForm.agent?.agentEnabled && (
                      <>
                        <Field
                          name="agentRunCommands"
                          label="Allow remote control"
                          tooltip={
                            <div className="space-y-2">
                              <p>Can the FrameOS agent actually run commands and execute updates?</p>
                              <p>
                                This is a second "are you really sure?" toggle, as this comes with risk when enabled on
                                an unsecure connection.
                              </p>
                              <p>
                                Make sure you're either aware of the risks, or that the backend is only accessible over
                                HTTPS before enabling this.
                              </p>
                            </div>
                          }
                        >
                          {({ value, onChange }) => (
                            <div className="w-full">
                              <Switch name="agentRunCommands" value={value} onChange={onChange} />
                            </div>
                          )}
                        </Field>
                        <Field
                          name="agentSharedSecret"
                          label={<div>Agent shared secret</div>}
                          labelRight={
                            <Button
                              color="secondary"
                              size="small"
                              onClick={() => {
                                setFrameFormValues({
                                  agent: { ...(frameForm.agent ?? {}), agentSharedSecret: secureToken(20) },
                                })
                                touchFrameFormField('agent.agentSharedSecret')
                              }}
                            >
                              Regenerate
                            </Button>
                          }
                          tooltip="This key is used as part of the handshake when communicating with the frame over websockets."
                        >
                          <TextInput
                            name="agentSharedSecret"
                            onClick={() => touchFrameFormField('agent.agentSharedSecret')}
                            type={frameFormTouches['agent.agentSharedSecret'] ? 'text' : 'password'}
                            placeholder=""
                            required
                          />
                        </Field>
                      </>
                    )}
                  </Group>
                </div>
              </>
            ) : null}
          </>
        ) : null}

        <H6 id="frame-settings-backend" className="mt-2">
          Backend access <span className="text-gray-500">(frame &#8594; backend)</span>
        </H6>
        <div className="pl-2 @md:pl-8 space-y-2">
          <Field
            name="server_host"
            label="Backend host"
            tooltip={
              <>
                The public host of your FrameOS backend server (this webserver). This is what the frame uses to reach
                the backend.
              </>
            }
          >
            <TextInput name="server_host" placeholder="localhost" required />
          </Field>
          <Field
            name="server_port"
            label="Backend port"
            tooltip="The port the backend server is running on. Everything ending in 443 is assumed to be HTTPS."
          >
            <TextInput name="server_port" placeholder="8989" required />
          </Field>
          <Field
            name="server_api_key"
            label={<div>Backend API key</div>}
            labelRight={
              <Button
                color="secondary"
                size="small"
                onClick={() => {
                  setFrameFormValues({ server_api_key: secureToken(32) })
                  touchFrameFormField('server_api_key')
                }}
              >
                Regenerate
              </Button>
            }
            tooltip="This key is used by the frame to access the backend server's API. For example to send logs. It should be kept secret."
          >
            <TextInput
              name="server_api_key"
              onClick={() => touchFrameFormField('server_api_key')}
              type={frameFormTouches.server_api_key ? 'text' : 'password'}
              placeholder=""
              required
            />
          </Field>
          <Field
            name="server_send_logs"
            label="Send logs to backend"
            tooltip="When disabled, the frame will not upload logs to the backend API."
          >
            {({ value, onChange }) => (
              <Switch name="server_send_logs" value={value ?? true} onChange={onChange} fullWidth />
            )}
          </Field>
        </div>

        {!isEmbeddedMode ? (
          <>
            <H6 id="frame-http-api-section">
              HTTP API on frame <span className="text-gray-500">(backend &#8594; frame)</span>
            </H6>
            <div className="pl-2 @md:pl-8 space-y-2">
              <Field
                name="frame_port"
                label="HTTP port on frame"
                tooltip={
                  <div className="space-y-2">
                    <p>The port on which the frame accepts HTTP API requests and serves a simple control interface.</p>
                    <p>
                      Traffic on this port is UNSECURED! Please also enable the HTTPS proxy service for secure
                      communication.
                    </p>
                  </div>
                }
              >
                <TextInput name="frame_port" placeholder="8787" required />
              </Field>
              <Field
                name="frame_access"
                label="HTTP access level"
                tooltip={
                  <div className="space-y-2">
                    <p>
                      <strong>Private (default):</strong> You need a key to both view and administer the frame.
                    </p>
                    <p>
                      <strong>Protected:</strong> Everyone can view the frame's image, but you need the access key to
                      administer content.
                    </p>
                    <p>
                      <strong>Public:</strong> Everyone can view or administer the frame without a key.
                    </p>
                  </div>
                }
              >
                <Select
                  name="frame_access"
                  options={[
                    { value: 'private', label: 'Private (key needed to view and administer)' },
                    { value: 'protected', label: 'Protected (no key needed to view, key needed to administer)' },
                    { value: 'public', label: 'Public (no key needed to view or administer)' },
                  ]}
                />
              </Field>
              <Field
                name="frame_access_key"
                label={<div>HTTP access key</div>}
                labelRight={
                  <Button
                    color="secondary"
                    size="small"
                    onClick={() => {
                      setFrameFormValues({ frame_access_key: secureToken(20) })
                      touchFrameFormField('frame_access_key')
                    }}
                  >
                    Regenerate
                  </Button>
                }
                tooltip="This key is used when communicating with the frame over HTTP."
              >
                <TextInput
                  name="frame_access_key"
                  onClick={() => touchFrameFormField('frame_access_key')}
                  type={frameFormTouches.frame_access_key ? 'text' : 'password'}
                  placeholder=""
                  required
                />
              </Field>
            </div>

            <H6 id="frame-settings-admin">Frame admin panel (BETA)</H6>
            <p className="pl-2 @md:pl-8 text-sm text-gray-500">
              Hosted on the frame at <code>/admin</code>, similar to the interface you&apos;re using now. This is still
              in beta: you can't save any changes.{' '}
            </p>
            <div className="pl-2 @md:pl-8 space-y-2">
              <Field
                name="frame_admin_auth.enabled"
                label="Admin panel enabled"
                labelRight={
                  adminUrl ? (
                    <A
                      href={adminUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="frameos-link text-sm hover:underline"
                    >
                      Open
                    </A>
                  ) : (
                    <></>
                  )
                }
              >
                <Switch />
              </Field>
              {frameForm.frame_admin_auth?.enabled ? (
                <>
                  <Field name="frame_admin_auth.user" label="Username">
                    <TextInput />
                  </Field>
                  <Field
                    name="frame_admin_auth.pass"
                    label="Password"
                    labelRight={
                      <Button color="secondary" size="small" onClick={() => generateFrameAdminCredentials()}>
                        Generate
                      </Button>
                    }
                  >
                    <TextInput
                      onClick={() => touchFrameFormField('frame_admin_auth.pass')}
                      type={frameFormTouches['frame_admin_auth.pass'] ? 'text' : 'password'}
                      placeholder=""
                      required
                    />
                  </Field>
                </>
              ) : null}
            </div>
            <H6 id="frame-http-proxy-section">
              HTTPS proxy <span className="text-gray-500">(backend &#8594; frame)</span>
            </H6>
            <div className="pl-2 @md:pl-8 space-y-2">
              <Field
                name="https_proxy.enable"
                label="HTTPS proxy via Caddy"
                tooltip="Enable Caddy as a local HTTPS proxy for the FrameOS HTTP API. You may need to do a full deploy if this is your first time enabling this."
              >
                {({ value, onChange }) => (
                  <Switch
                    name="https_proxy.enable"
                    value={value}
                    onChange={(enableTls) => {
                      if (enableTls) {
                        verifyTlsCertificates()
                      }
                      onChange(enableTls)
                    }}
                    fullWidth
                  />
                )}
              </Field>
              {tlsEnabled ? (
                <>
              <Field
                name="https_proxy.port"
                label="HTTPS port"
                tooltip={
                  <div className="space-y-2">
                    <p>The port Caddy listens on for HTTPS connections.</p>
                    <p>It's best if this ends with *443.</p>
                  </div>
                }
              >
                <NumberTextInput name="https_proxy.port" placeholder="8443" />
              </Field>
              <Field
                name="https_proxy.expose_only_port"
                label="Expose only HTTPS port"
                tooltip="Bind the HTTP port to 127.0.0.1 so only the HTTPS proxy is accessible externally."
              >
                <Switch name="https_proxy.expose_only_port" fullWidth />
              </Field>
              <Field
                name="https_proxy.certs.client_ca"
                label="HTTPS backend CA certificate"
                labelRight={
                  <Button color="secondary" size="small" onClick={(e) => generateTlsCertificates()}>
                    Regenerate
                  </Button>
                }
                tooltip="Used by the backend to validate HTTPS connections to this frame when TLS is enabled."
                secret={!frameFormTouches['https_proxy.certs.client_ca'] && !!frameForm.https_proxy?.certs?.client_ca}
                hint={getCertificateHint(
                  'Root CA certificate',
                  frameForm.https_proxy?.client_ca_cert_not_valid_after ??
                    frame.https_proxy?.client_ca_cert_not_valid_after
                )}
              >
                <TextArea name="https_proxy.certs.client_ca" rows={4} placeholder="-----BEGIN CERTIFICATE-----" />
              </Field>
              <Field
                name="https_proxy.certs.server"
                label="HTTPS frame certificate"
                tooltip="PEM certificate used by Caddy for HTTPS on this frame."
                secret={!frameFormTouches['https_proxy.certs.server'] && !!frameForm.https_proxy?.certs?.server}
                hint={getCertificateHint(
                  'Server certificate',
                  frameForm.https_proxy?.server_cert_not_valid_after ?? frame.https_proxy?.server_cert_not_valid_after
                )}
              >
                <TextArea name="https_proxy.certs.server" rows={4} placeholder="-----BEGIN CERTIFICATE-----" />
              </Field>

              <Field
                name="https_proxy.certs.server_key"
                label={<div>HTTPS frame private key</div>}
                tooltip="PEM private key used by Caddy for HTTPS on this frame. Keep this secret."
                secret={!frameFormTouches['https_proxy.certs.server_key'] && !!frameForm.https_proxy?.certs?.server_key}
              >
                <TextArea name="https_proxy.certs.server_key" rows={4} placeholder="-----BEGIN RSA PRIVATE KEY-----" />
              </Field>
            </>
          ) : null}
        </div>
          </>
        ) : null}

        <H6 id="frame-settings-network">Network</H6>
        <div className="pl-2 @md:pl-8 space-y-2">
          <Group name="network">
            {showWifiCredentials ? (
              <>
                <Field name="wifiSSID" label="WiFi network">
                  <TextInput name="wifiSSID" placeholder="Home WiFi" autoComplete="off" />
                </Field>
                <Field
                  name="wifiPassword"
                  label="WiFi password"
                  secret={!frameFormTouches['network.wifiPassword'] && !!frameForm.network?.wifiPassword}
                >
                  <TextInput
                    name="wifiPassword"
                    type={frameFormTouches['network.wifiPassword'] ? 'text' : 'password'}
                    placeholder="Network password"
                    autoComplete="new-password"
                  />
                </Field>
              </>
            ) : null}
            <Field name="networkCheck" label="Wait for network before rendering">
              <Switch name="networkCheck" fullWidth />
            </Field>
            {frameForm.network?.networkCheck && (
              <>
                <Field name="networkCheckUrl" label="Network check URL">
                  {({ onChange, value }) => (
                    <TextInput
                      name="networkCheckUrl"
                      placeholder="https://networkcheck.frameos.net/"
                      onChange={onChange}
                      value={value ?? 'https://networkcheck.frameos.net/'}
                    />
                  )}
                </Field>
                <Field name="networkCheckTimeoutSeconds" label="Network check timeout in seconds">
                  {({ onChange, value }) => (
                    <NumberTextInput
                      name="networkCheckTimeoutSeconds"
                      placeholder="30"
                      onChange={onChange}
                      value={value ?? 30}
                    />
                  )}
                </Field>
                {!isEmbeddedMode ? (
                  <>
                    <Field
                      name="wifiHotspot"
                      label="Wifi Hotspot Setup"
                      tooltip={
                        <div className="space-y-2">
                          <p>
                            When your frame can't connect to the internet on boot, it can spin up its own wifi access
                            point that you can connect to. This is useful for setting up a frame in a new location.
                          </p>
                          <p>
                            Just connect to 'FrameOS-Setup' with the password 'frame1234', open http://10.42.0.1/ and
                            enter your wifi credentials. The hotspot will only be active for 10 minutes by default.
                          </p>
                        </div>
                      }
                    >
                      <Select
                        options={[
                          { value: 'disabled', label: 'Disabled' },
                          { value: 'bootOnly', label: 'Enabled on boot if no network connection' },
                        ]}
                      />
                    </Field>
                    {frameForm.network?.wifiHotspot === 'bootOnly' && (
                      <>
                        <Field name="wifiHotspotSsid" label="Wifi Hotspot SSID">
                          {({ onChange, value }) => (
                            <TextInput
                              name="wifiHotspotSsid"
                              placeholder="FrameOS-Setup"
                              onChange={onChange}
                              value={value ?? 'FrameOS-Setup'}
                            />
                          )}
                        </Field>
                        <Field name="wifiHotspotPassword" label="Wifi Hotspot Password">
                          {({ onChange, value }) => (
                            <TextInput
                              name="wifiHotspotPassword"
                              placeholder="frame1234"
                              onChange={onChange}
                              value={value ?? 'frame1234'}
                            />
                          )}
                        </Field>
                        <Field
                          name="wifiHotspotTimeoutSeconds"
                          label="Wifi Hotspot Timeout in seconds"
                          tooltip="How long to keep the hotspot active after boot. After this timeout it won't turn on again without a reboot."
                        >
                          {({ onChange, value }) => (
                            <NumberTextInput
                              name="wifiHotspotTimeoutSeconds"
                              placeholder="300"
                              onChange={onChange}
                              value={value ?? 300}
                            />
                          )}
                        </Field>
                      </>
                    )}
                  </>
                ) : null}
              </>
            )}
          </Group>
        </div>

        {!isEmbeddedMode ? (
          <>
            <H6 id="frame-settings-mountpoints" className="flex items-center gap-2">
              Mountpoints
              <Button size="small" color="secondary" onClick={addMountpoint} className="flex items-center gap-1">
                <PlusIcon className="w-4 h-4" />
                Add mountpoint
              </Button>
            </H6>
            <div className="pl-2 @md:pl-8 space-y-2">
              <Group name="mountpoints">
                <Field
                  name="enabled"
                  label="Samba mounts"
                  tooltip="FrameOS installs CIFS support, manages its fstab block, and mounts these shares during setup."
                >
                  <Switch name="enabled" fullWidth />
                </Field>
                {frameForm.mountpoints?.enabled ? (
                  <div className="space-y-4">
                    {mountpointItems.length === 0 ? (
                      <div className="text-sm text-gray-500">No mountpoints configured.</div>
                    ) : null}
                    {mountpointItems.map((mountpoint, index) => (
                      <Group key={index} name={`items.${index}`}>
                        <div className="space-y-2 border-l border-gray-700 pl-3">
                          <Field
                            name="source"
                            label="SMB share"
                            labelRight={
                              <Button
                                color="secondary"
                                size="small"
                                className="flex items-center gap-1"
                                onClick={() => removeMountpoint(index)}
                              >
                                <TrashIcon className="w-4 h-4" />
                                Remove
                              </Button>
                            }
                          >
                            <TextInput name="source" placeholder="//server/share" />
                          </Field>
                          <Field name="target" label="Mount path">
                            <TextInput name="target" placeholder="/mnt/share" />
                          </Field>
                          <Field name="enabled" label="Enabled">
                            {({ value, onChange }) => <Switch value={value !== false} onChange={onChange} fullWidth />}
                          </Field>
                          <Field name="username" label="Username">
                            <TextInput name="username" placeholder="guest" />
                          </Field>
                          <Field name="password" label="Password">
                            <TextInput
                              name="password"
                              onClick={() => touchFrameFormField(`mountpoints.items.${index}.password`)}
                              type={frameFormTouches[`mountpoints.items.${index}.password`] ? 'text' : 'password'}
                              placeholder="guest access if empty"
                            />
                          </Field>
                          <Field name="domain" label="Domain">
                            <TextInput name="domain" placeholder="optional" />
                          </Field>
                          <Field name="options" label="Options" tooltip="Additional comma-separated mount.cifs options.">
                            <TextInput name="options" placeholder="vers=3.0,uid=pi,gid=pi" />
                          </Field>
                        </div>
                      </Group>
                    ))}
                  </div>
                ) : null}
              </Group>
            </div>
          </>
        ) : null}

        <H6 id="frame-settings-defaults">Defaults</H6>
        <div className="pl-2 @md:pl-8 space-y-2">
          <Field name="width" label="Width">
            <TextInput name="width" placeholder="1920" />
          </Field>
          <Field name="height" label="Height">
            <TextInput name="height" placeholder="1080" />
          </Field>
          <Field
            name="interval"
            label="Default refresh interval in seconds for new scenes"
            tooltip={
              <>
                How often do we trigger a refresh, in seconds. Pass a large number like "60" or even more for e-ink
                frames. A number below 1 activates realtime mode (0.041s = 24fps, 0.016s = 60fps). This should be used
                when you're certain of your setup and only if your hardware supports it.
              </>
            }
          >
            <TextInput name="interval" placeholder="300" />
          </Field>
          <Field name="metrics_interval" label="Metrics reporting interval in seconds, 0 to disable">
            <TextInput name="metrics_interval" placeholder="60" />
          </Field>
          <Group name="timezone_updater">
            <Field
              name="enabled"
              label="Update timezone data"
              tooltip="Download updated timezone rules on this frame so daylight saving changes stay current."
            >
              {({ value, onChange }) => {
                const enabled = value ?? true
                return (
                  <div className="space-y-3">
                    <div className="flex w-full items-start gap-3">
                      <Switch value={enabled} onChange={onChange} />
                      {enabled ? (
                        <details className="min-w-0 flex-1">
                          <summary className="frameos-link cursor-pointer list-none text-sm font-semibold">
                            advanced
                          </summary>
                          <div className="mt-3 w-full space-y-2">
                            <div className="space-y-1 @md:flex @md:gap-2">
                              <Label className="@md:w-1/3">
                                Timezone update hour
                                <Tooltip title="Hour of day on the frame when timezone data updates run." />
                              </Label>
                              <div className="w-full">
                                <TextInput
                                  inputMode="numeric"
                                  pattern="[0-9]*"
                                  placeholder={String(DEFAULT_TIMEZONE_UPDATE_HOUR)}
                                  value={timezoneUpdateHourValue}
                                  onChange={setTimezoneUpdateHour}
                                />
                              </div>
                            </div>
                            <div className="space-y-1 @md:flex @md:gap-2">
                              <Label className="@md:w-1/3">Timezone update URL</Label>
                              <div className="w-full">
                                <TextInput
                                  placeholder={DEFAULT_TIMEZONE_UPDATE_URL}
                                  value={timezoneUpdateUrlValue}
                                  onChange={(url) => setTimezoneUpdaterValue({ url: url || undefined })}
                                />
                              </div>
                            </div>
                          </div>
                        </details>
                      ) : null}
                    </div>
                  </div>
                )
              }}
            </Field>
          </Group>
          <Field
            name="max_http_response_bytes"
            label="Maximum HTTP response size for apps"
            tooltip={
              <>
                Maximum number of bytes that FrameOS apps may download in a single HTTP response. Increase this for
                larger calendar feeds, images, or APIs.
              </>
            }
          >
            <NumberTextInput name="max_http_response_bytes" placeholder="67108864" />
          </Field>
          <Field name="scaling_mode" label="Scaling mode">
            <Select
              name="scaling_mode"
              options={[
                { value: 'contain', label: 'Contain' },
                { value: 'cover', label: 'Cover' },
                { value: 'stretch', label: 'Stretch' },
                { value: 'center', label: 'Center' },
              ]}
            />
          </Field>
          <Field name="image_engine" label="Image engine">
            <Select
              name="image_engine"
              options={[
                { value: '', label: 'Default (Pixie)' },
                { value: 'pixie', label: 'Pixie' },
                { value: 'imagemagick', label: 'ImageMagick' },
              ]}
            />
          </Field>
        </div>

        <H6 id="frame-settings-error-behavior">Global errors</H6>
        <div className="pl-2 @md:pl-8 space-y-3">
          <Field name="error_behavior.mode" label="Unrecoverable error behavior">
            <div className="grid w-full gap-2 @xl:grid-cols-3">
              {errorBehaviorModes.map((option) => {
                const selected = errorBehavior.mode === option.value
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setErrorBehavior({ mode: option.value })}
                    className={clsx(
                      'frame-tool-row min-h-28 rounded-lg p-3 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
                      selected ? 'border-blue-500 ring-2 ring-blue-500/30' : 'hover:border-slate-400'
                    )}
                    aria-pressed={selected}
                  >
                    <span className="frameos-strong block text-sm font-semibold">{option.title}</span>
                    <span className="frame-tool-muted mt-1 block text-xs leading-5">{option.description}</span>
                  </button>
                )
              })}
            </div>
          </Field>
          {errorBehavior.mode === 'show_error_retry' ? (
            <Field
              name="error_behavior.retry_seconds"
              label="Retry delay"
              tooltip="After a fatal error, render the error screen and retry after this many seconds."
            >
              <NumberTextInput
                value={errorBehavior.retry_seconds ?? DEFAULT_FRAME_ERROR_BEHAVIOR.retry_seconds}
                onChange={(value) => setErrorBehavior({ retry_seconds: value })}
                placeholder="60"
              />
            </Field>
          ) : null}
          {errorBehavior.mode === 'silent_retry' ? (
            <>
              <Field
                name="error_behavior.silent_retry_seconds"
                label="Silent retry delay"
                tooltip="While retrying silently, keep the current frame image and retry after this many seconds."
              >
                <NumberTextInput
                  value={errorBehavior.silent_retry_seconds ?? DEFAULT_FRAME_ERROR_BEHAVIOR.silent_retry_seconds}
                  onChange={(value) => setErrorBehavior({ silent_retry_seconds: value })}
                  placeholder="60"
                />
              </Field>
              <Field
                name="error_behavior.silent_retry_forever"
                label="Retry silently forever"
                tooltip="When enabled, the frame never replaces the current image with a fatal error screen."
              >
                <Switch
                  value={!!errorBehavior.silent_retry_forever}
                  onChange={(value) => setErrorBehavior({ silent_retry_forever: value })}
                  fullWidth
                />
              </Field>
              {!errorBehavior.silent_retry_forever ? (
                <>
                  <Field
                    name="error_behavior.silent_window_minutes"
                    label="Silent window"
                    tooltip="Retry silently for this many minutes before switching to the visible error screen."
                  >
                    <NumberTextInput
                      value={errorBehavior.silent_window_minutes ?? DEFAULT_FRAME_ERROR_BEHAVIOR.silent_window_minutes}
                      onChange={(value) => setErrorBehavior({ silent_window_minutes: value })}
                      placeholder="10"
                    />
                  </Field>
                  <Field
                    name="error_behavior.show_error_retry_seconds"
                    label="Visible retry delay"
                    tooltip="After the silent window expires, render the error screen and retry after this many seconds."
                  >
                    <NumberTextInput
                      value={
                        errorBehavior.show_error_retry_seconds ?? DEFAULT_FRAME_ERROR_BEHAVIOR.show_error_retry_seconds
                      }
                      onChange={(value) => setErrorBehavior({ show_error_retry_seconds: value })}
                      placeholder="60"
                    />
                  </Field>
                </>
              ) : null}
            </>
          ) : null}
        </div>

        <H6 id="frame-settings-palette">Palette</H6>
        {frame.device && withCustomPalette[frame.device] ? (
          <div className="pl-2 @md:pl-8 space-y-2">
            <Field name="palette" label="Color palette">
              {({ value, onChange }: { value: Palette; onChange: (v: Palette) => void }) => (
                <div className="space-y-2 w-full">
                  <div className="flex items-center gap-2">
                    <span>Set&nbsp;to</span>
                    <Select
                      name="palette"
                      value={''}
                      onChange={(v) => {
                        const selectedPalette = spectraPalettes.find((p) => p.name === v)
                        if (selectedPalette) {
                          onChange(selectedPalette)
                        }
                      }}
                      options={[
                        { value: '', label: '' },
                        ...spectraPalettes.map((palette) => ({
                          value: palette.name || '',
                          label: palette.name || 'Custom',
                        })),
                      ]}
                    />
                  </div>
                  {palette?.colors.map((color, index) => (
                    <div className="flex items-center gap-2" key={index}>
                      <ColorInput
                        className="!w-24"
                        name={`colors.${index}`}
                        value={value?.colors?.[index] ?? color}
                        onChange={(_value) => {
                          const newColors = palette.colors.map((c, i) =>
                            i === index ? _value : value?.colors?.[i] ?? c ?? '#000000'
                          )
                          onChange({ colors: newColors })
                        }}
                      />
                      <TextInput
                        type="text"
                        className="!w-24"
                        name={`colors.${index}`}
                        value={value?.colors?.[index] ?? color}
                        onChange={(_value) => {
                          const newColors = palette.colors.map((c, i) =>
                            i === index ? _value : value?.colors?.[i] ?? c ?? '#000000'
                          )
                          onChange({ colors: newColors })
                        }}
                      />
                      <span>{palette?.colorNames?.[index]}</span>
                    </div>
                  ))}
                </div>
              )}
            </Field>
          </div>
        ) : (
          <div>This frame does not support changing the palette</div>
        )}

        <H6 id="frame-settings-qr">QR Control Code</H6>
        <div className="pl-2 @md:pl-8 space-y-2">
          <Group name="control_code">
            <Field name="enabled" label="QR Control Code">
              <Select
                name="enabled"
                options={[
                  { value: 'false', label: 'Disabled' },
                  { value: 'true', label: 'Enabled' },
                ]}
              />
            </Field>
            {String(frameForm.control_code?.enabled) === 'true' && (
              <>
                <Field name="position" label="Position">
                  {({ value, onChange }) => (
                    <Select
                      name="position"
                      value={value ?? 'top-right'}
                      onChange={onChange}
                      options={[
                        { value: 'top-left', label: 'Top Left' },
                        { value: 'top-right', label: 'Top Right' },
                        { value: 'bottom-left', label: 'Bottom Left' },
                        { value: 'bottom-right', label: 'Bottom Right' },
                        { value: 'center', label: 'Center' },
                      ]}
                    />
                  )}
                </Field>
                <Field name="size" label="Size of each square in pixels">
                  <TextInput name="size" placeholder="2" />
                </Field>
                <Field name="padding" label="Padding around code">
                  <TextInput name="padding" placeholder="1" />
                </Field>
                <Field name="offsetX" label="X offset">
                  <TextInput name="offsetX" placeholder="0" />
                </Field>
                <Field name="offsetY" label="Y offset">
                  <TextInput name="offsetY" placeholder="0" />
                </Field>
                <Field name="qrCodeColor" label="QR code color">
                  <ColorInput
                    name="qrCodeColor"
                    value={frameForm.control_code?.qrCodeColor ?? '#000000'}
                    placeholder="#000000"
                  />
                </Field>
                <Field name="backgroundColor" label="Background color">
                  <ColorInput
                    name="backgroundColor"
                    value={frameForm.control_code?.backgroundColor ?? '#ffffff'}
                    placeholder="#ffffff"
                  />
                </Field>
              </>
            )}
          </Group>
        </div>
        {!isEmbeddedMode ? (
          <>
            <H6 id="frame-settings-assets">Assets</H6>
            <div className="pl-2 @md:pl-8 space-y-2">
              <Field
                name="assets_path"
                label={<div>Assets path</div>}
                labelRight={
                  !isBuildrootMode ? (
                    <Button
                      color="secondary"
                      size="small"
                      onClick={() => {
                        setFrameFormValues({ assets_path: '/srv/assets' })
                        touchFrameFormField('assets_path')
                      }}
                    >
                      Set default
                    </Button>
                  ) : undefined
                }
                tooltip="Path on frame where to store assets like images, videos, and custom fonts."
              >
                {({ value, onChange }) => (
                  <TextInput
                    name="assets_path"
                    value={isBuildrootMode ? '/srv/assets' : value ?? ''}
                    onChange={onChange}
                    onClick={() => touchFrameFormField('assets_path')}
                    type="text"
                    placeholder="/srv/assets"
                    disabled={isBuildrootMode}
                    required
                  />
                )}
              </Field>
              <Field
                name="save_assets"
                label={<div>Save downloaded images as assets</div>}
                tooltip="This controls the 'auto' setting for 'Save assets' in the following apps. Please note that individual apps/scenes may have overridden the default set here."
              >
                <>
                  <div className="space-y-2 w-full">
                    {Object.entries({
                      _all: 'All',
                      ...appsWithSaveAssets,
                    }).map(([keyword, name]) => (
                      <label key={keyword} className="flex gap-1">
                        <input
                          type="checkbox"
                          checked={
                            typeof frameForm.save_assets === 'boolean'
                              ? frameForm.save_assets
                              : !!frameForm.save_assets?.[keyword]
                          }
                          value={'true'}
                          onChange={(e) => {
                            const checked = !!e.target.checked
                            if (keyword === '_all') {
                              setFrameFormValues({ save_assets: checked })
                            } else {
                              const prevValues =
                                typeof frameForm.save_assets === 'object'
                                  ? frameForm.save_assets
                                  : frameForm.save_assets === true
                                  ? Object.fromEntries(Object.entries(appsWithSaveAssets).map(([k]) => [k, true]))
                                  : {}
                              setFrameFormValues({
                                save_assets: {
                                  ...prevValues,
                                  [keyword]: checked,
                                },
                              })
                            }
                            touchFrameFormField('save_assets')
                          }}
                        />
                        {name}
                      </label>
                    ))}
                  </div>
                </>
              </Field>
              {!inFrameAdminMode ? (
                <Field
                  name="upload_fonts"
                  label="Upload fonts"
                  tooltip="When deploying a frame, FrameOS uploads fonts to /srv/assets/fonts. You can disable this here"
                >
                  <Select
                    name="upload_fonts"
                    options={[
                      { value: '', label: 'All' },
                      { value: 'none', label: 'None' },
                    ]}
                  />
                </Field>
              ) : null}
            </div>
            <H6 id="frame-settings-gpio" className="flex items-center gap-2">
              GPIO buttons
              {!inkyAutoButtonDevice ? (
                <Button
                  size="small"
                  color="secondary"
                  onClick={() => setFrameFormValues({ gpio_buttons: [...(frameForm.gpio_buttons || []), {}] })}
                  className="flex items-center gap-1"
                >
                  <PlusIcon className="w-4 h-4" />
                  Add button
                </Button>
              ) : null}
            </H6>
            <div className="pl-2 @md:pl-8 space-y-2">
              {inkyAutoButtonDevice ? (
                <div>
                  Inky Impression boards automatically configure pins 5, 6, {inkyThirteenDevice ? '25' : '16'} and 24
                  as buttons A, B, C and D
                </div>
              ) : (
                frameForm.gpio_buttons?.map((_, index) => (
                  <Group key={index} name={`gpio_buttons.${index}`}>
                    <div>
                      <Field
                        name="pin"
                        label="Pin"
                        labelRight={
                          <Button
                            color="secondary"
                            size="small"
                            className="flex items-center gap-1"
                            onClick={() =>
                              setFrameFormValues({
                                gpio_buttons: frameForm.gpio_buttons?.filter((_, i) => i !== index),
                              })
                            }
                          >
                            <TrashIcon className="w-4 h-4" />
                            Remove
                          </Button>
                        }
                      >
                        <TextInput name="pin" placeholder="5" />
                      </Field>
                      <Field name="label" label="Label">
                        <TextInput name="label" placeholder="A" />
                      </Field>
                    </div>
                  </Group>
                ))
              )}
            </div>
            <H6 id="frame-settings-logs">Logs</H6>
            <div className="pl-2 @md:pl-8 space-y-2">
              <Field
                name="log_to_file"
                label={<div>Save logs to file</div>}
                labelRight={
                  <Button
                    color="secondary"
                    size="small"
                    onClick={() => {
                      setFrameFormValues({ log_to_file: '/srv/frameos/logs/frame-{date}.log' })
                      touchFrameFormField('log_to_file')
                    }}
                  >
                    Set default
                  </Button>
                }
                tooltip="This is disabled by default to save the SD card from wear. This is ALSO disabled because there is no log rotation, so the file will grow indefinitely. Use with caution. The string {date} will be replaced with the current date."
              >
                <TextInput
                  name="log_to_file"
                  onClick={() => touchFrameFormField('log_to_file')}
                  type="text"
                  placeholder="e.g. /srv/frameos/logs/frame-{date}.log"
                  required
                />
              </Field>
            </div>
            <H6 id="frame-settings-reboot">Reboot</H6>
            <div className="pl-2 @md:pl-8 space-y-2">
              <Group name="reboot">
                <Field name="enabled" label="Automatic reboot">
                  <Select
                    name="enabled"
                    options={[
                      { value: 'false', label: 'Disabled' },
                      { value: 'true', label: 'Enabled' },
                    ]}
                  />
                </Field>
                {String(frameForm.reboot?.enabled) === 'true' && (
                  <>
                    <Field name="crontab" label="Reboot time">
                      <Select
                        name="crontab"
                        options={[...Array(24).keys()].map((hour) => ({
                          value: `0 ${hour} * * *`,
                          label: `${hour.toString().padStart(2, '0')}:00`,
                        }))}
                      />
                    </Field>
                    <Field name="type" label="What to reboot">
                      <Select
                        name="type"
                        options={[
                          { value: 'frameos', label: 'FrameOS' },
                          { value: 'raspberry', label: 'System reboot' },
                        ]}
                      />
                    </Field>
                  </>
                )}
              </Group>
            </div>
          </>
        ) : null}
      </Form>
    </div>
  )
}
