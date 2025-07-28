import { useActions, useValues } from 'kea'
import { Button } from '../../../../components/Button'
import { framesModel } from '../../../../models/framesModel'
import { Form, Group } from 'kea-forms'
import { TextInput } from '../../../../components/TextInput'
import { Select } from '../../../../components/Select'
import { frameControlUrl, frameUrl } from '../../../../decorators/frame'
import { frameLogic } from '../../frameLogic'
import { downloadJson } from '../../../../utils/downloadJson'
import { Field } from '../../../../components/Field'
import { devices, spectraPalettes, withCustomPalette, platforms, modes, devicesNixOS } from '../../../../devices'
import { secureToken } from '../../../../utils/secureToken'
import { appsLogic } from '../Apps/appsLogic'
import { frameSettingsLogic } from './frameSettingsLogic'
import { Spinner } from '../../../../components/Spinner'
import { H6 } from '../../../../components/H6'
import { DropdownMenu } from '../../../../components/DropdownMenu'
import { ArrowDownTrayIcon, ArrowPathIcon, ArrowUpTrayIcon } from '@heroicons/react/24/outline'
import { PlusIcon, TrashIcon } from '@heroicons/react/24/solid'
import { panelsLogic } from '../panelsLogic'
import { Switch } from '../../../../components/Switch'
import { NumberTextInput } from '../../../../components/NumberTextInput'
import { Palette } from '../../../../types'
import { A } from 'kea-router'
import { timezoneOptions } from '../../../../decorators/timezones'

export interface FrameSettingsProps {
  className?: string
  hideDropdown?: boolean
  hideDeploymentMode?: boolean
}

export function FrameSettings({ className, hideDropdown, hideDeploymentMode }: FrameSettingsProps) {
  const { mode, frameId, frame, frameForm, frameFormTouches } = useValues(frameLogic)
  const { touchFrameFormField, setFrameFormValues } = useActions(frameLogic)
  const { deleteFrame } = useActions(framesModel)
  const { appsWithSaveAssets } = useValues(appsLogic)
  const { clearBuildCache, downloadBuildZip } = useActions(frameSettingsLogic({ frameId }))
  const { buildCacheLoading } = useValues(frameSettingsLogic({ frameId }))
  const { openLogs } = useActions(panelsLogic({ frameId }))
  const url = frameUrl(frame)
  const controlUrl = frameControlUrl(frame)

  const palette = withCustomPalette[frame.device || '']

  if (!frame) {
    return (
      <div className={className}>
        Loading frame {frameId}...
        <Spinner />
      </div>
    )
  }

  return (
    <div className={className}>
      {!hideDropdown ? (
        <div className="float-right">
          <DropdownMenu
            className="w-fit"
            buttonColor="secondary"
            items={[
              ...(mode === 'rpios'
                ? [
                    {
                      label: 'Clear build cache',
                      onClick: () => {
                        clearBuildCache()
                        openLogs()
                      },
                      icon: buildCacheLoading ? (
                        <Spinner color="white" className="w-4 h-4" />
                      ) : (
                        <ArrowPathIcon className="w-5 h-5" />
                      ),
                    },
                  ]
                : []),
              {
                label: 'Import .json',
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
              },
              {
                label: 'Export .json',
                onClick: () => {
                  downloadJson(frame, `${frame.name || `frame${frame.id}`}.json`)
                },
                icon: <ArrowUpTrayIcon className="w-5 h-5" />,
              },
              {
                label: 'Download build .zip',
                onClick: () => {
                  downloadBuildZip()
                },
                icon: <ArrowUpTrayIcon className="w-5 h-5" />,
              },
              {
                label: 'Delete frame',
                onClick: () => {
                  if (confirm('Are you sure you want to DELETE this frame?')) {
                    deleteFrame(frame.id)
                  }
                },
                icon: <TrashIcon className="w-5 h-5" />,
              },
            ]}
          />
        </div>
      ) : null}
      <Form
        formKey="frameForm"
        logic={frameLogic}
        props={{ frameId }}
        className="space-y-4 @container"
        enableFormOnSubmit
      >
        <H6 className="mt-2">Basic Settings</H6>
        <div className="pl-2 @md:pl-8 space-y-2">
          <Field name="name" label="Name">
            <TextInput name="name" placeholder="Hallway frame" required />
          </Field>
          {!hideDeploymentMode ? (
            <Field name="mode" label="Deployment mode">
              <Select name="mode" options={modes} />
            </Field>
          ) : null}
          <Field
            name="device"
            label="Device"
            tooltip="We're adding support for all the devices really soon. This is an early beta feature after all."
          >
            <Select name="device" options={mode === 'nixos' ? devicesNixOS : devices} />
          </Field>
          {frameForm.mode === 'nixos' ? (
            <Field name="nix.platform" label="Platform">
              <Select name="nix.platform" options={platforms} />
            </Field>
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
        </div>

        {frameForm.mode == 'nixos' ? (
          <>
            <H6 className="mt-2">System settings</H6>
            <div className="pl-2 @md:pl-8 space-y-2">
              <Field
                name="nix.hostname"
                label="Hostname"
                tooltip="You can use the hostname specificied here followed by .local to access the frame over mDNS."
              >
                <TextInput name="nix.hostname" placeholder={`frame${frame.id}`} />
              </Field>
              <Field name="ssh_user" label="Username" tooltip='The user is always "frame"'>
                <TextInput name="ssh_user" value="frame" disabled required />
              </Field>
              <Field
                name="ssh_pass"
                label="Password"
                secret={!!frameForm.ssh_pass}
                tooltip={
                  <div>
                    <p>
                      Whatever you specify here is used for both SSH and terminal access. You can leave it blank to
                      disable password access.
                    </p>
                    <p>
                      You can also access the frame with the SSH key configured under{' '}
                      <A href="/settings" className="text-blue-400 hover:underline">
                        global settings.
                      </A>
                    </p>
                  </div>
                }
              >
                <TextInput
                  name="ssh_pass"
                  onClick={() => touchFrameFormField('ssh_pass')}
                  type={frameFormTouches.ssh_pass ? 'text' : 'password'}
                  placeholder="no password, using SSH key"
                />
              </Field>
              <Field name="nix.timezone" label="Timezone">
                <Select name="nix.timezone" options={timezoneOptions} />
              </Field>
            </div>
          </>
        ) : null}

        <H6 className="mt-2">
          SSH <span className="text-gray-500">(backend &#8594; frame)</span>
        </H6>
        <div className="pl-2 @md:pl-8 space-y-2">
          <Field
            name="frame_host"
            label="Frame host"
            tooltip={
              <div className="space-y-2">
                <p>The hostname or IP address that the backend uses to connect to the frame for SSH and HTTP.</p>
                <p>You can leave it blank if you only use the FrameOS agent to communicate.</p>
              </div>
            }
          >
            <TextInput name="frame_host" placeholder="127.0.0.1" required />
          </Field>
          {frameForm.mode !== 'nixos' ? (
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
                    <A href="/settings" className="text-blue-400 hover:underline">
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
            </>
          ) : null}
          <Field name="ssh_port" label="SSH port">
            <TextInput name="ssh_port" placeholder="22" required />
          </Field>
        </div>

        <H6>
          FrameOS Agent <span className="text-gray-500">(backend &#8594; frame)</span>
        </H6>
        <div className="pl-2 @md:pl-8 space-y-2">
          <Group name="agent">
            <Field
              name="agentEnabled"
              label="Enable FrameOS Agent (beta)"
              tooltip={
                <div className="space-y-2">
                  <p>
                    The FrameOS Agent opens a websocket connection from the frame to the backend, which is then used to
                    control the frame, pass logs and more. This allows you to control the frame even if it's behind a
                    firewall. The backend must be publicly accessible for this to work.
                  </p>
                  <p>
                    This is still beta. Enable both toggles, then save. Download the SD card image, and deploy it to the
                    frame. The agent will then connect to the frame to await further commands.
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
                  label="Run commands through the agent (beta)"
                  tooltip={
                    <div className="space-y-2">
                      <p>Can the FrameOS agent actually run commands and execute updates?</p>
                      <p>
                        This is a second "are you really sure?" toggle, as this comes with risk when enabled on an
                        unsecure connection.
                      </p>
                      <p>
                        Make sure you're either aware of the risks, or that the backend is only accessible over HTTPS
                        before enabling this.
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

        <H6 className="mt-2">
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
        </div>

        <H6>HTTP API on frame</H6>
        <div className="pl-2 @md:pl-8 space-y-2">
          <Field
            name="frame_port"
            label="FrameOS port"
            tooltip={
              <div className="space-y-2">
                <p>The port on which the frame accepts HTTP API requests and serves a simple control interface.</p>
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
                  <strong>Private (default):</strong> You need a key to both view and control the frame.
                </p>
                <p>
                  <strong>Protected:</strong> Everyone can view the frame's image, but you need the access key to update
                  content.
                </p>
                <p>
                  <strong>Public:</strong> Everyone can view or control the frame without a key.
                </p>
              </div>
            }
          >
            <Select
              name="frame_access"
              options={[
                { value: 'private', label: 'Private (key needed to view and edit)' },
                { value: 'protected', label: 'Protected (no key needed to view, key needed to edit)' },
                { value: 'public', label: 'Public (no key needed to view or edit)' },
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
          {frame.frame_host ? (
            <Field name="_noop" label="Load">
              <div className="w-full">
                <A href={url} target="_blank" rel="noreferrer noopener" className="text-blue-400 hover:underline">
                  Frame URL
                </A>
                {', '}
                <A
                  href={controlUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-blue-400 hover:underline"
                >
                  Control URL
                </A>
              </div>
            </Field>
          ) : null}
        </div>

        <H6>Network</H6>
        <div className="pl-2 @md:pl-8 space-y-2">
          <Group name="network">
            {frameForm.mode === 'nixos' ? (
              <>
                <Field name="wifiSSID" label="Wifi SSID" tooltip="The SSID of the wifi network to connect to on boot.">
                  <TextInput name="wifiSSID" placeholder="MyWifi" />
                </Field>
                <Field name="wifiPassword" label="Wifi Password" secret={!!frameForm.network?.wifiPassword}>
                  <TextInput name="wifiPassword" placeholder="MyWifiPassword" />
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
                <Field
                  name="wifiHotspot"
                  label="Wifi Hotspot Setup"
                  tooltip={
                    <div className="space-y-2">
                      <p>
                        When your frame can't connect to the internet on boot, it can spin up its own wifi access point
                        that you can connect to. This is useful for setting up a frame in a new location.
                      </p>
                      <p>
                        Just connect to 'FrameOS-Setup' with the password 'frame1234', open http://10.42.0.1/ and enter
                        your wifi credentials. The hotspot will only be active for 10 minutes by default.
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
            )}
          </Group>
        </div>

        <H6>Defaults</H6>
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
        </div>

        <H6>Palette</H6>
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
                      <TextInput
                        type="color"
                        theme="node"
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

        <H6>QR Control Code</H6>
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
                  <TextInput
                    type="color"
                    name="qrCodeColor"
                    value={frameForm.control_code?.qrCodeColor ?? '#000000'}
                    placeholder="#000000"
                  />
                </Field>
                <Field name="backgroundColor" label="Background color">
                  <TextInput
                    type="color"
                    name="backgroundColor"
                    value={frameForm.control_code?.backgroundColor ?? '#ffffff'}
                    placeholder="#ffffff"
                  />
                </Field>
              </>
            )}
          </Group>
        </div>
        <H6>Assets</H6>
        <div className="pl-2 @md:pl-8 space-y-2">
          <Field
            name="assets_path"
            label={<div>Assets path</div>}
            labelRight={
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
            }
            tooltip="Path on frame where to store assets like images, videos, and custom fonts."
          >
            <TextInput
              name="assets_path"
              onClick={() => touchFrameFormField('assets_path')}
              type="text"
              placeholder="/srv/assets"
              required
            />
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
        </div>
        <H6 className="flex items-center gap-2">
          GPIO buttons
          {frameForm.device !== 'pimoroni.inky_impression' && frameForm.device !== 'pimoroni.inky_impression_13' ? (
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
          {frameForm.device === 'pimoroni.inky_impression' || frameForm.device === 'pimoroni.inky_impression_13' ? (
            <div>
              Inky Impression boards automatically configure pins 5, 6,{' '}
              {frameForm.device === 'pimoroni.inky_impression_13' ? '25' : '16'} and 24 as buttons A, B, C and D
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
        <H6>Logs</H6>
        <div className="pl-2 @md:pl-8 space-y-2">
          <Field
            name="log_to_file"
            label={<div>Save logs to file</div>}
            labelRight={
              <Button
                color="secondary"
                size="small"
                onClick={() => {
                  if (frameForm.mode === 'nixos') {
                    setFrameFormValues({ log_to_file: '/var/log/frameos/frame-{date}.log' })
                  } else {
                    setFrameFormValues({ log_to_file: '/srv/frameos/logs/frame-{date}.log' })
                  }
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
          <Field name="debug" label="Debug logging (noisy)">
            <Select
              name="debug"
              options={[
                { value: 'false', label: 'Disabled' },
                { value: 'true', label: 'Enabled' },
              ]}
            />
          </Field>
        </div>
        <H6>Reboot</H6>
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
                    options={[
                      { value: '0 0 * * *', label: '00:00' },
                      { value: '1 0 * * *', label: '01:00' },
                      { value: '2 0 * * *', label: '02:00' },
                      { value: '3 0 * * *', label: '03:00' },
                      { value: '4 0 * * *', label: '04:00' },
                      { value: '5 0 * * *', label: '05:00' },
                      { value: '6 0 * * *', label: '06:00' },
                      { value: '7 0 * * *', label: '07:00' },
                      { value: '8 0 * * *', label: '08:00' },
                      { value: '9 0 * * *', label: '09:00' },
                      { value: '10 0 * * *', label: '10:00' },
                      { value: '11 0 * * *', label: '11:00' },
                      { value: '12 0 * * *', label: '12:00' },
                      { value: '13 0 * * *', label: '13:00' },
                      { value: '14 0 * * *', label: '14:00' },
                      { value: '15 0 * * *', label: '15:00' },
                      { value: '16 0 * * *', label: '16:00' },
                      { value: '17 0 * * *', label: '17:00' },
                      { value: '18 0 * * *', label: '18:00' },
                      { value: '19 0 * * *', label: '19:00' },
                      { value: '20 0 * * *', label: '20:00' },
                      { value: '21 0 * * *', label: '21:00' },
                      { value: '22 0 * * *', label: '22:00' },
                      { value: '23 0 * * *', label: '23:00' },
                    ]}
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
      </Form>
    </div>
  )
}
FrameSettings.PanelTitle = function FrameSettingsPanelTitle(): JSX.Element {
  return <>Settings</>
}
