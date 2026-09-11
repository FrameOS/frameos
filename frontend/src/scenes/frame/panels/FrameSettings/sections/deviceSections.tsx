import { Group } from 'kea-forms'
import { A } from 'kea-router'
import { AdvancedSection } from '../../../../../components/AdvancedSection'
import { Button } from '../../../../../components/Button'
import { Field } from '../../../../../components/Field'
import { NumberTextInput } from '../../../../../components/NumberTextInput'
import { PartialRefreshSettingsFields } from '../../../../../components/PartialRefreshSettingsFields'
import { PowerSettingsFields } from '../../../../../components/PowerSettingsFields'
import { Select } from '../../../../../components/Select'
import { Switch } from '../../../../../components/Switch'
import { Tag } from '../../../../../components/Tag'
import { TextInput } from '../../../../../components/TextInput'
import { frameRootUrl } from '../../../../../decorators/frame'
import {
  buildrootPlatforms,
  devices,
  EMBEDDED_ESP32_S3,
  modes,
  normalizeBuildrootPlatform,
  partialRefreshDefaultsByDevice,
  partialRefreshDevices,
  virtualColorModes,
} from '../../../../../devices'
import {
  frameCompilationModeOptions,
  normalizeFrameCompilationModeOption,
} from '../../../../../utils/frameBuildOptions'
import type { FrameType } from '../../../../../types'
import { FrameActionsMenu } from '../FrameActionsMenu'
import { useFrameSettings } from '../frameSettingsContext'
import { CertificateTriangle, scrollToFrameHttpApiSection, VirtualFrameUrlRow } from '../frameSettingsHelpers'
import {
  DEFAULT_MAX_HTTP_RESPONSE_BYTES,
  EMBEDDED_DEFAULT_MAX_HTTP_RESPONSE_BYTES,
  esp32HardwarePresetConfig,
  esp32PinLayoutsEqual,
  esp32RecommendedPinLayout,
  normalizeEsp32PinLayout,
} from '../esp32Hardware'
import { Esp32HardwareFields } from './esp32HardwareFields'
import { FlipField } from '../fields/sharedFields'
import { FrameSettingsSection, SectionBody, SectionHeading } from './FrameSettingsSection'

/** The frame itself: where it is, what board it is, how it is powered. */

/**
 * Frame info: the URLs the frame answers on, and the IPs it was last seen
 * from. A cloud frame is reached only through the hub, so it has neither.
 */
export function FrameInfoSection(): JSX.Element | null {
  const {
    frame,
    frameForm,
    showFrameInfo,
    inFrameAdminMode,
    logs,
    ipAddresses,
    tlsEnabled,
    url,
    controlUrl,
    adminUrl,
    imageUrl,
  } = useFrameSettings()
  if (!showFrameInfo) {
    return null
  }
  return (
    <>
      <SectionHeading id="frame-settings-info" action={<FrameActionsMenu />}>
        Frame info
      </SectionHeading>
      <SectionBody>
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
              <A href={controlUrl} target="_blank" rel="noreferrer noopener" className="frameos-link hover:underline">
                Control URL
              </A>
              {adminUrl ? (
                <A href={adminUrl} target="_blank" rel="noreferrer noopener" className="frameos-link hover:underline">
                  Admin URL
                </A>
              ) : null}
              <A href={imageUrl} target="_blank" rel="noreferrer noopener" className="frameos-link hover:underline">
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
      </SectionBody>
    </>
  )
}

/**
 * Device settings: deployment mode, display driver, board and its wiring. The
 * cloud renders none of it — the device owns all of it.
 */
export function DeviceSettingsSection(): JSX.Element {
  const {
    frameForm,
    mode,
    setFrameFormValues,
    hideDeploymentMode,
    inFrameAdminMode,
    isBuildrootMode,
    isEmbeddedMode,
    isVirtualPlatform,
    showFrameInfo,
    embeddedHardwarePreset,
    frameTimezoneOptions,
  } = useFrameSettings()
  return (
    <>
      {showFrameInfo ? (
        <SectionHeading id="frame-settings-device" className="mt-2">
          Device settings
        </SectionHeading>
      ) : (
        <SectionHeading id="frame-settings-device" action={<FrameActionsMenu />}>
          Device settings
        </SectionHeading>
      )}
      <SectionBody>
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
                  if (nextMode === 'embedded') {
                    const nextValues: Partial<FrameType> = {}
                    if (!frameForm.embedded?.platform) {
                      nextValues.embedded = {
                        ...(frameForm.embedded ?? {}),
                        platform: EMBEDDED_ESP32_S3,
                        flashSize: frameForm.embedded?.flashSize ?? '8MB',
                      }
                    } else if (!frameForm.embedded?.flashSize) {
                      nextValues.embedded = { ...(frameForm.embedded ?? {}), flashSize: '8MB' }
                    }
                    if (
                      !frameForm.max_http_response_bytes ||
                      frameForm.max_http_response_bytes === DEFAULT_MAX_HTTP_RESPONSE_BYTES
                    ) {
                      nextValues.max_http_response_bytes = EMBEDDED_DEFAULT_MAX_HTTP_RESPONSE_BYTES
                    }
                    nextValues.device_config = {
                      ...(frameForm.device_config ?? {}),
                      pins: normalizeEsp32PinLayout(
                        frameForm.device_config?.pins,
                        frameForm.device,
                        embeddedHardwarePreset
                      ),
                    }
                    setFrameFormValues({
                      ...nextValues,
                    })
                  }
                }}
              />
            )}
          </Field>
        ) : null}
        {isVirtualPlatform ? null : (
          <Field name="device" label="Display driver">
            {({ value, onChange }) => (
              <Select
                name="device"
                value={(value as string) || ''}
                options={
                  // Embedded frames can be headless: device "none" maps to the
                  // firmware's panel "none", so surface it as a real choice.
                  isEmbeddedMode ? [{ value: 'none', label: 'No display panel' }, ...devices] : devices
                }
                onChange={(nextDevice) => {
                  const previousDevice = (value as string) || ''
                  onChange(nextDevice)
                  if (isEmbeddedMode) {
                    const currentPins = frameForm.device_config?.pins
                    const currentPresetConfig = esp32HardwarePresetConfig(embeddedHardwarePreset)
                    const nextHardwarePreset =
                      currentPresetConfig && nextDevice !== currentPresetConfig.device
                        ? 'custom'
                        : embeddedHardwarePreset
                    const previousPins = normalizeEsp32PinLayout(currentPins, previousDevice, embeddedHardwarePreset)
                    const nextDeviceConfig: NonNullable<FrameType['device_config']> = {
                      ...(frameForm.device_config ?? {}),
                    }
                    const nextValues: Partial<FrameType> = {}
                    let shouldUpdateDeviceConfig = false
                    if (
                      !currentPins ||
                      esp32PinLayoutsEqual(
                        previousPins,
                        esp32RecommendedPinLayout(previousDevice, embeddedHardwarePreset)
                      )
                    ) {
                      nextDeviceConfig.pins = esp32RecommendedPinLayout(nextDevice, nextHardwarePreset)
                      shouldUpdateDeviceConfig = true
                    }
                    if (nextHardwarePreset === 'custom' && embeddedHardwarePreset !== 'custom') {
                      nextValues.embedded = {
                        ...(frameForm.embedded ?? {}),
                        hardwarePreset: 'custom',
                      }
                      nextDeviceConfig.hardwarePreset = 'custom'
                      shouldUpdateDeviceConfig = true
                    }
                    if (shouldUpdateDeviceConfig) {
                      nextValues.device_config = nextDeviceConfig
                    }
                    if (Object.keys(nextValues).length > 0) {
                      setFrameFormValues({
                        ...nextValues,
                      })
                    }
                  }
                }}
              />
            )}
          </Field>
        )}
        {frameForm.device === 'waveshare.EPD_10in3' ? (
          <Group name="device_config">
            <Field name="vcom" label="VCOM">
              <TextInput name="vcom" placeholder="-1.48" required />
            </Field>
          </Group>
        ) : null}
        {partialRefreshDevices.has(frameForm.device ?? '') ? (
          <Field name="device_config">
            {({ value, onChange }) => (
              <PartialRefreshSettingsFields
                value={value as FrameType['device_config']}
                onChange={onChange}
                variant="settings"
                panelDefaults={partialRefreshDefaultsByDevice[frameForm.device ?? '']}
              />
            )}
          </Field>
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
                      idx === index ? { name: header?.name ?? '', value: header?.value ?? '', [key]: newValue } : header
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
        <FlipField />
        {isBuildrootMode ? (
          <Group name="buildroot">
            <Field name="platform" label="Platform">
              {({ value, onChange }) => (
                // Frames saved before the platform consolidation still store
                // 'raspberry-pi-zero-w' / 'raspberry-pi-zero-2-w', which match
                // no option and render the select blank. Show the platform
                // whose image actually boots that board (the backend resolves
                // the legacy keys the same way), so the field reads as the
                // truth instead of as "unset".
                <Select
                  name="buildroot.platform"
                  options={buildrootPlatforms}
                  value={normalizeBuildrootPlatform(value)}
                  onChange={(v) => onChange(v)}
                />
              )}
            </Field>
            <AdvancedSection
              open={normalizeFrameCompilationModeOption(frameForm.buildroot?.compilationMode) === 'static'}
            >
              <Field
                name="compilationMode"
                label="Installation mode"
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
            </AdvancedSection>
          </Group>
        ) : null}
        {isEmbeddedMode ? <Esp32HardwareFields /> : null}
        {/* The form's mode, not the saved one: switching the select to
            Raspberry Pi OS reveals it without a save. */}
        {!inFrameAdminMode && (frameForm.mode === 'rpios' || !frameForm.mode) ? (
          <Group name="rpios">
            <AdvancedSection open={normalizeFrameCompilationModeOption(frameForm.rpios?.compilationMode) === 'static'}>
              <Field
                name="compilationMode"
                label="Installation mode"
                tooltip={
                  <div className="space-y-2">
                    <p>
                      Choose how FrameOS is installed on this frame. Install binaries uses the published FrameOS release
                      for the current version when the frame only uses interpreted scenes.
                    </p>
                    <p>
                      Building from source is only needed for compiled scenes or for testing local changes that are not
                      in a published release yet.
                    </p>
                  </div>
                }
              >
                <Select name="rpios.compilationMode" options={frameCompilationModeOptions} />
              </Field>
            </AdvancedSection>
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
      </SectionBody>
    </>
  )
}

/**
 * A virtual frame has no board: the backend renders it and serves the result
 * at the URLs below.
 */
export function VirtualFrameSection(): JSX.Element | null {
  const { frame, frameForm, isVirtualPlatform, virtualViewToken, virtualImageUrl, virtualPageUrl } = useFrameSettings()
  if (!isVirtualPlatform) {
    return null
  }
  return (
    <>
      <SectionHeading id="frame-settings-virtual" className="mt-2">
        Virtual frame
      </SectionHeading>
      <SectionBody>
        <p className="frameos-muted text-sm">
          The backend renders this frame and serves it at the URLs below. The token only grants viewing this
          frame&apos;s image — still, treat the URLs as semi-private; save a new view token to invalidate them.
        </p>
        {!virtualViewToken ? (
          <p className="text-sm font-semibold text-amber-600">
            No view token is set for this frame yet. Save the frame once and the URLs will fill in.
          </p>
        ) : null}
        <VirtualFrameUrlRow label="Image URL (PNG, rendered on request)" url={virtualImageUrl} />
        <VirtualFrameUrlRow
          label={`Kiosk page URL (refreshes every ${frameForm.interval ?? frame.interval ?? 300} seconds)`}
          url={virtualPageUrl}
        />
        <Field name="width" label="Width">
          <TextInput name="width" placeholder="800" />
        </Field>
        <Field name="height" label="Height">
          <TextInput name="height" placeholder="480" />
        </Field>
        <Group name="device_config">
          <Field
            name="colorMode"
            label="Color mode"
            tooltip="How the backend quantizes the rendered image — pick an e-ink palette to preview how a scene would look on a physical panel."
          >
            {({ value, onChange }) => (
              <Select
                name="device_config.colorMode"
                value={(value as string) || 'rgb'}
                options={virtualColorModes}
                onChange={onChange}
              />
            )}
          </Field>
          <Field
            name="assetsQuotaMb"
            label="Assets quota (MB)"
            tooltip="How much disk space this frame's assets may use on the backend — uploads and images scenes save (OpenAI, Wikimedia, ...). Leave empty for the default of 100 MB."
          >
            {({ value, onChange }) => (
              <TextInput
                name="device_config.assetsQuotaMb"
                type="number"
                placeholder="100"
                value={value === undefined || value === null ? '' : String(value)}
                onChange={(newValue) => {
                  const parsed = parseFloat(String(newValue))
                  onChange(Number.isFinite(parsed) && parsed > 0 ? parsed : undefined)
                }}
              />
            )}
          </Field>
        </Group>
      </SectionBody>
    </>
  )
}

/**
 * Power management for a backend-managed ESP32. Same knobs the cloud pushes
 * over set_settings, stored in device_config here: USB provisioning sends them
 * once and the device's settings poll re-reads them, so a change takes effect
 * without a reflash.
 */
export function EmbeddedPowerSection(): JSX.Element | null {
  const { showEmbeddedPowerSection, embeddedPowerSettings, setEmbeddedPowerSettings } = useFrameSettings()
  if (!showEmbeddedPowerSection) {
    return null
  }
  return (
    <>
      <SectionHeading id="frame-settings-power" row>
        Power
      </SectionHeading>
      <SectionBody className="">
        <PowerSettingsFields
          value={embeddedPowerSettings}
          onChange={setEmbeddedPowerSettings}
          footnote="These reach the board on its next settings poll (firmware from 2026.8.21 on applies them live) and are sent over USB when a board is provisioned."
        />
      </SectionBody>
    </>
  )
}
