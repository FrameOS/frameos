import { Group } from 'kea-forms'
import { PlusIcon, TrashIcon } from '@heroicons/react/24/solid'
import { Button } from '../../../../../components/Button'
import { Field } from '../../../../../components/Field'
import { H6 } from '../../../../../components/H6'
import { NumberTextInput } from '../../../../../components/NumberTextInput'
import { Select } from '../../../../../components/Select'
import { Switch } from '../../../../../components/Switch'
import { TextInput } from '../../../../../components/TextInput'
import { useFrameSettings } from '../frameSettingsContext'
import {
  ControlCodeFields,
  ErrorBehaviorFields,
  MaxHttpResponseBytesField,
  MetricsIntervalField,
  PaletteField,
  SaveAssetsField,
  TimezoneUpdaterFields,
} from '../fields/sharedFields'
import { FrameSettingsSection, SectionBody, SectionHeading } from './FrameSettingsSection'

/**
 * The operating system underneath FrameOS, and the defaults every scene
 * inherits: network, mounts, sizes and intervals, error handling, palette, the
 * QR control code, assets, logs and the reboot schedule.
 *
 * A cloud-managed frame renders none of these: the device owns them, and the
 * cloud has neither a verb to push them nor a value to show. The Pi/Linux
 * cloud surface does offer four of the same FIELD blocks inside its own
 * fieldsets (fields/sharedFields.tsx) — the blocks are shared, the sections
 * are not.
 */

export function NetworkSection(): JSX.Element {
  const { frameForm, frameFormTouches, isEmbeddedMode, showWifiCredentials, touchFrameFormField } = useFrameSettings()
  return (
    <>
      <SectionHeading id="frame-settings-network">Network</SectionHeading>
      <SectionBody>
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
              <Field
                name="wifiCountry"
                label="WiFi country"
                tooltip="Two-letter country code (FR, US, …): the radio's regulatory domain. Without it the frame cannot join access points on 2.4 GHz channels 12 or 13."
              >
                <TextInput name="wifiCountry" placeholder="FR" autoComplete="off" maxLength={2} />
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
                          When your frame can&apos;t connect to the internet on boot, it can spin up its own wifi access
                          point that you can connect to. This is useful for setting up a frame in a new location.
                        </p>
                        <p>
                          Just connect to &apos;FrameOS-Setup&apos; with the password &apos;frame1234&apos;, open
                          http://10.42.0.1/ and enter your wifi credentials. The hotspot will only be active for 10
                          minutes by default.
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
                      <Field
                        name="wifiHotspotPassword"
                        label="Wifi Hotspot Password"
                        secret={
                          !frameFormTouches['network.wifiHotspotPassword'] && !!frameForm.network?.wifiHotspotPassword
                        }
                      >
                        {({ onChange, value }) => (
                          <TextInput
                            name="wifiHotspotPassword"
                            type={frameFormTouches['network.wifiHotspotPassword'] ? 'text' : 'password'}
                            placeholder="frame1234"
                            autoComplete="new-password"
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
      </SectionBody>
    </>
  )
}

export function MountpointsSection(): JSX.Element | null {
  const {
    frameForm,
    frameFormTouches,
    isEmbeddedMode,
    isBuildrootMode,
    mountpointItems,
    addMountpoint,
    removeMountpoint,
    touchFrameFormField,
  } = useFrameSettings()
  // Samba mounts are a `frameos setup` step that needs apt (cifs-utils) and
  // a writable /etc/fstab: Raspberry Pi OS only. The Buildroot images have
  // neither and setup skips the step there, so the form would save
  // mountpoints that never mount.
  if (isEmbeddedMode || isBuildrootMode) {
    return null
  }
  return (
    <>
      <H6 id="frame-settings-mountpoints" className="flex items-center gap-2">
        Mountpoints
        <Button size="small" color="secondary" onClick={addMountpoint} className="flex items-center gap-1">
          <PlusIcon className="w-4 h-4" />
          Add mountpoint
        </Button>
      </H6>
      <SectionBody>
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
              {mountpointItems.map((_mountpoint, index) => (
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
                    <Field name="target" label="Mount path" hint="A directory under /mnt, /media or /srv/assets">
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
      </SectionBody>
    </>
  )
}

export function DefaultsSection(): JSX.Element {
  return (
    <>
      <SectionHeading id="frame-settings-defaults">Defaults</SectionHeading>
      <SectionBody>
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
              How often do we trigger a refresh, in seconds. Pass a large number like &quot;60&quot; or even more for
              e-ink frames. A number below 1 activates realtime mode (0.041s = 24fps, 0.016s = 60fps). This should be
              used when you&apos;re certain of your setup and only if your hardware supports it.
            </>
          }
        >
          <TextInput name="interval" placeholder="300" />
        </Field>
        <MetricsIntervalField />
        <TimezoneUpdaterFields />
        <MaxHttpResponseBytesField />
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
      </SectionBody>
    </>
  )
}

export function ErrorBehaviorSection(): JSX.Element {
  return (
    <>
      <SectionHeading id="frame-settings-error-behavior">Global errors</SectionHeading>
      <SectionBody className="space-y-3">
        <ErrorBehaviorFields />
      </SectionBody>
    </>
  )
}

export function PaletteSection(): JSX.Element {
  const { palette } = useFrameSettings()
  return (
    <>
      <SectionHeading id="frame-settings-palette">Palette</SectionHeading>
      {palette ? (
        <SectionBody>
          <PaletteField />
        </SectionBody>
      ) : (
        <div>This frame does not support changing the palette</div>
      )}
    </>
  )
}

export function QrControlCodeSection(): JSX.Element {
  return (
    <>
      <SectionHeading id="frame-settings-qr">QR Control Code</SectionHeading>
      <SectionBody>
        <ControlCodeFields />
      </SectionBody>
    </>
  )
}

export function AssetsSection(): JSX.Element | null {
  const { isBuildrootMode, isEmbeddedMode, surface, setFrameFormValues, touchFrameFormField } = useFrameSettings()
  if (isEmbeddedMode) {
    return null
  }
  return (
    <>
      <SectionHeading id="frame-settings-assets">Assets</SectionHeading>
      <SectionBody>
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
        <SaveAssetsField />
        {/* Font upload is a deploy step the backend runs; the on-device panel
            does not deploy, and the cloud never renders this section. */}
        {surface === 'backend' ? (
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
      </SectionBody>
    </>
  )
}

export function LogsSection(): JSX.Element | null {
  const { isEmbeddedMode, setFrameFormValues, touchFrameFormField } = useFrameSettings()
  if (isEmbeddedMode) {
    return null
  }
  return (
    <>
      <SectionHeading id="frame-settings-logs">Logs</SectionHeading>
      <SectionBody>
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
      </SectionBody>
    </>
  )
}

export function RebootSection(): JSX.Element | null {
  const { frameForm, isEmbeddedMode, adminLoginIsOnlyAccess } = useFrameSettings()
  // The cron line behind this is written by a full deploy over SSH; a frame
  // reached only over its admin API never gets one. Its Schedule panel's
  // reboot event is the device-side equivalent.
  if (isEmbeddedMode || adminLoginIsOnlyAccess) {
    return null
  }
  return (
    <>
      <SectionHeading id="frame-settings-reboot">Reboot</SectionHeading>
      <SectionBody>
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
      </SectionBody>
    </>
  )
}
