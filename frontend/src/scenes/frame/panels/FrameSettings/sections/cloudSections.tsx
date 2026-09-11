import { Field } from '../../../../../components/Field'
import { PartialRefreshSettingsFields } from '../../../../../components/PartialRefreshSettingsFields'
import { PowerSettingsFields } from '../../../../../components/PowerSettingsFields'
import { Select } from '../../../../../components/Select'
import { Switch } from '../../../../../components/Switch'
import { TextInput } from '../../../../../components/TextInput'
import { partialRefreshDefaultsByDevice, partialRefreshDevices } from '../../../../../devices'
import {
  esp32ExtendedCloudFrameSettingsMinVersion,
  esp32TimeZoneCloudFrameSettingsMinVersion,
  extendedCloudFrameSettingsMinVersion,
  hardwareCloudFrameSettingsMinVersion,
} from '../../../../../utils/cloudFrameApi'
import type { FrameType } from '../../../../../types'
import { FrameActionsMenu } from '../FrameActionsMenu'
import { useFrameSettings } from '../frameSettingsContext'
import {
  ControlCodeFields,
  ErrorBehaviorFields,
  FlipField,
  GpioButtonsSection,
  MaxHttpResponseBytesField,
  MetricsIntervalField,
  PaletteField,
  SaveAssetsField,
  TimezoneUpdaterFields,
} from '../fields/sharedFields'
import {
  FrameSettingsSection,
  SectionBody,
  SectionHeading,
  useFrameSettingsSectionRenders,
} from './FrameSettingsSection'

/**
 * What a cloud-managed frame's Settings panel renders.
 *
 * A cloud frame accepts only the declarative `set_settings` subset. Everything
 * else this panel knows how to draw (mounts, network, palette, GPIO, …) is
 * either absent from the device profile or provisioned on the frame itself, so
 * rendering those sections is an invitation to edit values that can never be
 * saved — the device does not merely ignore an unknown key, it refuses the
 * whole push.
 *
 * The two cloud surfaces differ in which keys their device actually applies:
 * cloudFrameSettingKeys / esp32CloudFrameSettingKeys in
 * utils/cloudFrameSettings.ts are the lists this mirrors. Which sections reach
 * which surface is declared in frameSettingsSurface.ts, not here.
 */

/** Name, refresh interval, rotation, scaling — what both cloud surfaces push. */
export function CloudBaseSettingsSection(): JSX.Element {
  const { surface, frame, frameTimezoneOptions, cloudEsp32TimeZoneSupported } = useFrameSettings()
  const esp32 = surface === 'cloudEsp32'
  return (
    <>
      <SectionHeading id="frame-settings-info" action={<FrameActionsMenu />}>
        Frame settings
      </SectionHeading>
      <SectionBody>
        <Field name="name" label="Name">
          <TextInput name="name" placeholder="Hallway frame" required />
        </Field>
        <Field
          name="interval"
          label="Refresh interval in seconds"
          tooltip="How often the frame re-renders its active scene. E-paper panels want large values (300 or more); the firmware enforces a 5 second minimum."
        >
          <TextInput name="interval" placeholder="300" />
        </Field>
        <Field
          name="rotate"
          label="Rotation"
          tooltip="How the scene is rotated onto the panel. The firmware sizes its canvas once at boot, so saving a new rotation reboots the frame."
        >
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
        <Field
          name="scaling_mode"
          label="Scaling mode"
          tooltip="The fallback fit for images whose scene node does not choose its own placement. Applied on the next render — no reboot."
        >
          {({ value, onChange }) => (
            <Select
              value={value || 'cover'}
              onChange={onChange}
              name="scaling_mode"
              options={[
                { value: 'cover', label: 'Cover (fill the panel, crop the overflow)' },
                { value: 'contain', label: 'Contain (fit inside, letterbox)' },
                { value: 'stretch', label: 'Stretch' },
                { value: 'center', label: 'Center (no scaling)' },
              ]}
            />
          )}
        </Field>
        {esp32 ? (
          <fieldset disabled={!cloudEsp32TimeZoneSupported} className="min-w-0">
            <Field
              name="timezone"
              label="Time zone"
              tooltip={
                cloudEsp32TimeZoneSupported
                  ? 'The time zone the frame keeps its clock in: scene times, the weather forecast and the schedule. Applied live — no reboot.'
                  : frame.frameos_version
                  ? `The time zone needs FrameOS ${esp32TimeZoneCloudFrameSettingsMinVersion} or newer on the frame (this one reports ${frame.frameos_version}). Update the frame to set it here.`
                  : `The time zone needs FrameOS ${esp32TimeZoneCloudFrameSettingsMinVersion} or newer on the frame. It unlocks once the frame connects and reports its version.`
              }
            >
              <Select name="timezone" options={frameTimezoneOptions} />
            </Field>
          </fieldset>
        ) : (
          <>
            <Field
              name="timezone"
              label="Time zone"
              tooltip="The time zone scenes render in. Applied on the next render — no reboot."
            >
              <Select name="timezone" options={frameTimezoneOptions} />
            </Field>
            <Field
              name="debug"
              label="Debug logging"
              tooltip="Verbose per-render logging on the device. Useful while a scene misbehaves; noisy otherwise."
            >
              <Switch name="debug" fullWidth />
            </Field>
          </>
        )}
        <p className="frameos-muted text-sm">
          {esp32
            ? 'This ESP32 frame accepts its name, refresh interval, rotation, scaling mode, time zone and the power settings below from the cloud. The panel driver, WiFi, GPIO and other hardware settings are provisioned on the device itself — over its USB console or the FrameOS-Setup portal.'
            : 'These are the settings a cloud-managed frame accepts. Everything else this frame runs on — its panel and display driver, network and WiFi, GPIO buttons, mount points, palette and log settings — is owned by the device and configured on the frame itself, through its own admin panel or the card it was flashed from.'}
        </p>
      </SectionBody>
    </>
  )
}

/**
 * The 2026.8.30 batch (extendedCloudFrameSettingKeys), Pi/Linux only. A frame
 * below the floor refuses the WHOLE push on the first unknown key, so the
 * fields render disabled — never hidden — with the reason, and
 * pushCloudFrameSettings leaves them out of the payload.
 */
export function CloudExtendedSettingsSections(): JSX.Element | null {
  const { frame, cloudExtendedSettingsSupported } = useFrameSettings()
  const renders = useFrameSettingsSectionRenders('cloud-defaults')
  if (!renders) {
    return null
  }
  return (
    <fieldset disabled={!cloudExtendedSettingsSupported} className="min-w-0 space-y-4">
      <SectionHeading id="frame-settings-defaults" row className="mt-4">
        Defaults
      </SectionHeading>
      <SectionBody>
        {!cloudExtendedSettingsSupported ? (
          <p className="frameos-muted text-sm">
            {frame.frameos_version
              ? `These settings need FrameOS ${extendedCloudFrameSettingsMinVersion} or newer on the frame (this one reports ${frame.frameos_version}). Update the frame to edit them here.`
              : `These settings need FrameOS ${extendedCloudFrameSettingsMinVersion} or newer on the frame. They unlock once the frame connects and reports its version.`}
          </p>
        ) : null}
        <FlipField />
        <MetricsIntervalField />
        <TimezoneUpdaterFields />
        <MaxHttpResponseBytesField />
        <SaveAssetsField />
      </SectionBody>
      <SectionHeading id="frame-settings-error-behavior" row className="mt-4">
        Global errors
      </SectionHeading>
      <SectionBody className="space-y-3">
        <ErrorBehaviorFields />
      </SectionBody>
      <SectionHeading id="frame-settings-qr" row className="mt-4">
        QR Control Code
      </SectionHeading>
      <SectionBody>
        <ControlCodeFields />
      </SectionBody>
    </fieldset>
  )
}

/**
 * The 2026.8.31 hardware batch (hardwareCloudFrameSettingKeys), Pi/Linux only.
 * The display driver reads these at init, so a save that carries one restarts
 * the runtime on the frame. Only the fields the reported panel can use are
 * rendered; below the floor they render disabled with the reason, never
 * hidden.
 */
export function CloudHardwareSection(): JSX.Element | null {
  const { frame, palette, paletteDevice, cloudHardwareSettingsSupported } = useFrameSettings()
  const renders = useFrameSettingsSectionRenders('cloud-hardware')
  if (!renders) {
    return null
  }
  return (
    <fieldset disabled={!cloudHardwareSettingsSupported} className="min-w-0 space-y-4">
      <SectionHeading id="frame-settings-hardware" row className="mt-4">
        Panel
      </SectionHeading>
      <SectionBody>
        {!cloudHardwareSettingsSupported ? (
          <p className="frameos-muted text-sm">
            {frame.frameos_version
              ? `Palette, partial refresh and GPIO button settings need FrameOS ${hardwareCloudFrameSettingsMinVersion} or newer on the frame (this one reports ${frame.frameos_version}). Update the frame to edit them here.`
              : `Palette, partial refresh and GPIO button settings need FrameOS ${hardwareCloudFrameSettingsMinVersion} or newer on the frame. They unlock once the frame connects and reports its version.`}
          </p>
        ) : (
          <p className="frameos-muted text-sm">
            The panel driver reads these when it starts, so saving a change here restarts FrameOS on the frame (a few
            seconds of blank panel).
          </p>
        )}
        {palette ? <PaletteField /> : null}
        {partialRefreshDevices.has(paletteDevice) ? (
          <Field name="device_config">
            {({ value, onChange }) => (
              <PartialRefreshSettingsFields
                value={value as FrameType['device_config']}
                onChange={onChange}
                variant="settings"
                panelDefaults={partialRefreshDefaultsByDevice[paletteDevice]}
              />
            )}
          </Field>
        ) : null}
      </SectionBody>
      <GpioButtonsSection />
    </fieldset>
  )
}

/**
 * ESP32 only. The Pi runtime's CLOUD_SETTINGS_ALLOWLIST does not know the
 * power keys, so pushing them at a Linux frame refuses the whole verb — every
 * other setting in the same save included.
 */
export function CloudEsp32Sections(): JSX.Element | null {
  const {
    frame,
    cloudPowerSettings,
    setCloudPowerSettings,
    cloudBatteryEnablePinDisabledReason,
    cloudEsp32ExtendedSettingsSupported,
  } = useFrameSettings()
  const renders = useFrameSettingsSectionRenders('cloud-esp32-power')
  if (!renders) {
    return null
  }
  return (
    <>
      <SectionHeading id="frame-settings-power" row className="mt-4">
        Power
      </SectionHeading>
      <SectionBody className="">
        <PowerSettingsFields
          value={cloudPowerSettings}
          onChange={setCloudPowerSettings}
          batteryEnablePinDisabledReason={cloudBatteryEnablePinDisabledReason}
          footnote="Power settings need a FrameOS firmware from 2026.8.21 on — older firmware refuses the whole settings push. Update the frame first if saving fails."
        />
      </SectionBody>
      {/* Firmware ≥ 2026.8.31 only (esp32ExtendedCloudFrameSettingKeys):
          older firmware refuses the whole push on any of these, so below the
          floor they render disabled with the reason. */}
      <fieldset disabled={!cloudEsp32ExtendedSettingsSupported} className="min-w-0 space-y-4">
        <SectionHeading id="frame-settings-esp32-extended" row className="mt-4">
          Device
        </SectionHeading>
        <SectionBody>
          {!cloudEsp32ExtendedSettingsSupported ? (
            <p className="frameos-muted text-sm">
              {frame.frameos_version
                ? `Debug logging, the HTTP response limit and GPIO buttons need FrameOS ${esp32ExtendedCloudFrameSettingsMinVersion} or newer on the frame (this one reports ${frame.frameos_version}). Update the frame to edit them here.`
                : `Debug logging, the HTTP response limit and GPIO buttons need FrameOS ${esp32ExtendedCloudFrameSettingsMinVersion} or newer on the frame. They unlock once the frame connects and reports its version.`}
            </p>
          ) : (
            <p className="frameos-muted text-sm">
              Debug logging applies on the next render. The HTTP response limit and GPIO buttons are read at boot, so
              saving a change to them reboots the frame.
            </p>
          )}
          <Field
            name="debug"
            label="Debug logging"
            tooltip="Verbose per-render logging on the device. Useful while a scene misbehaves; noisy otherwise."
          >
            <Switch name="debug" fullWidth />
          </Field>
          <MaxHttpResponseBytesField />
        </SectionBody>
        <GpioButtonsSection />
      </fieldset>
    </>
  )
}
