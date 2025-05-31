import { useActions, useValues } from 'kea'
import { Button } from '../../../../components/Button'
import { framesModel } from '../../../../models/framesModel'
import { Form, Group } from 'kea-forms'
import { TextInput } from '../../../../components/TextInput'
import { Select } from '../../../../components/Select'
import { frameLogic } from '../../frameLogic'
import { downloadJson } from '../../../../utils/downloadJson'
import { Field } from '../../../../components/Field'
import { devices } from '../../../../devices'
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

export interface FrameSettingsProps {
  className?: string
}

export function FrameSettings({ className }: FrameSettingsProps) {
  const { frameId, frame, frameForm, frameFormTouches } = useValues(frameLogic)
  const { touchFrameFormField, setFrameFormValues } = useActions(frameLogic)
  const { deleteFrame } = useActions(framesModel)
  const { appsWithSaveAssets } = useValues(appsLogic)
  const { clearBuildCache } = useActions(frameSettingsLogic({ frameId }))
  const { buildCacheLoading } = useValues(frameSettingsLogic({ frameId }))
  const { openLogs } = useActions(panelsLogic({ frameId }))

  return (
    <div className={className}>
      {!frame ? (
        `Loading frame ${frameId}...`
      ) : (
        <>
          <div className="float-right">
            <DropdownMenu
              className="w-fit"
              buttonColor="secondary"
              items={[
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
                    downloadJson(frame, `${frame.name || `frame-${frame.id}`}.json`)
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
          <Form
            formKey="frameForm"
            logic={frameLogic}
            props={{ frameId }}
            className="space-y-4 @container"
            enableFormOnSubmit
          >
            <H6 className="mt-2">Frame Settings</H6>
            <div className="pl-2 @md:pl-8 space-y-2">
              <Field name="name" label="Name">
                <TextInput name="name" placeholder="Hallway frame" required />
              </Field>
              <Field name="device" label="Device">
                <Select name="device" options={devices} />
              </Field>
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
            <H6>Connection</H6>
            <div className="pl-2 @md:pl-8 space-y-2">
              <Field name="frame_host" label="Frame host">
                <TextInput name="frame_host" placeholder="127.0.0.1" required />
              </Field>
              <Field name="frame_port" label="Frame port">
                <TextInput name="frame_port" placeholder="8787" required />
              </Field>
              <Field
                name="frame_access"
                label="Frame access"
                tooltip={
                  <div className="space-y-2">
                    <p>
                      <strong>Private (default):</strong> You need a key to both view and control the frame.
                    </p>
                    <p>
                      <strong>Protected:</strong> Everyone can view the frame's image, but you need the access key to
                      update content.
                    </p>
                    <p>
                      <strong>Public:</strong> Everyone can view or control the frame without a key. This makes for the
                      smallest QR codes.
                    </p>
                    <p>
                      Please note that frames are currenly accessed over unsecured HTTP. You can still capture the key
                      by intercepting network traffic. More secure methods are planned.
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
                label={<div>Frame access key</div>}
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
              <Field name="ssh_user" label="SSH user">
                <TextInput name="ssh_user" placeholder="pi" required />
              </Field>
              <Field name="ssh_pass" label="SSH pass">
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
              <Field name="server_host" label="Server host">
                <TextInput name="server_host" placeholder="localhost" required />
              </Field>
              <Field name="server_port" label="Server port">
                <TextInput name="server_port" placeholder="8989" required />
              </Field>
              <Field
                name="server_api_key"
                label={<div>Server API key</div>}
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
                tooltip="This is the API key that the frame uses to communicate with the server. It should be kept secret."
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
            <H6>Network</H6>
            <div className="pl-2 @md:pl-8 space-y-2">
              <Group name="network">
                <Field name="networkCheck" label="Wait for network before rendering">
                  {({ value, onChange }) => <Switch name="networkCheck" value={value} onChange={onChange} />}
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
                          name="wifiHotspotTimeout"
                          label="Wifi Hotspot Timeout in seconds"
                          tooltip="How long to keep the hotspot active after boot. After this timeout it won't turn on again without a reboot."
                        >
                          {({ onChange, value }) => (
                            <NumberTextInput
                              name="wifiHotspotTimeout"
                              placeholder="600"
                              onChange={onChange}
                              value={value ?? 600}
                            />
                          )}
                        </Field>
                      </>
                    )}
                  </>
                )}
              </Group>
            </div>
            <H6>Agent</H6>
            <div className="pl-2 @md:pl-8 space-y-2">
              <Group name="network">
                <Field name="agentEnabled" label="Enable FrameOS Agent (EXPERIMENTAL)">
                  {({ value, onChange }) => <Switch name="agentEnabled" value={value} onChange={onChange} />}
                </Field>
                {frameForm.network?.agentEnabled && (
                  <>
                    <Field name="agentConnection" label="Enable Agent reverse tunnel (EXPERIMENTAL)">
                      {({ value, onChange }) => <Switch name="agentConnection" value={value} onChange={onChange} />}
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
                              network: { ...(frameForm.network ?? {}), agentSharedSecret: secureToken(20) },
                            })
                            touchFrameFormField('network.agentSharedSecret')
                          }}
                        >
                          Regenerate
                        </Button>
                      }
                      tooltip="This key is used when communicating with the frame over secure websockets."
                    >
                      <TextInput
                        name="agentSharedSecret"
                        onClick={() => touchFrameFormField('network.agentSharedSecret')}
                        type={frameFormTouches['network.agentSharedSecret'] ? 'text' : 'password'}
                        placeholder=""
                        required
                      />
                    </Field>
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
                    frames. A number below 1 activates realtime mode (0.041s = 24fps, 0.016s = 60fps). This should be
                    used when you're certain of your setup and only if your hardware supports it.
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
        </>
      )}
    </div>
  )
}
FrameSettings.PanelTitle = function FrameSettingsPanelTitle(): JSX.Element {
  return <>Settings</>
}
