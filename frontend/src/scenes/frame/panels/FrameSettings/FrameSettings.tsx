import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import { Button } from '../../../../components/Button'
import { framesModel } from '../../../../models/framesModel'
import { Form } from 'kea-forms'
import { TextInput } from '../../../../components/TextInput'
import { Select } from '../../../../components/Select'
import { frameLogic } from '../../frameLogic'
import { downloadJson } from '../../../../utils/downloadJson'
import { Field } from '../../../../components/Field'
import { devices } from '../../../../devices'
import { secureToken } from '../../../../utils/secureToken'

export interface FrameSettingsProps {
  className?: string
}

export function FrameSettings({ className }: FrameSettingsProps) {
  const { frameId, frame, frameFormTouches } = useValues(frameLogic)
  const { touchFrameFormField, setFrameFormValues } = useActions(frameLogic)
  const { deleteFrame } = useActions(framesModel)

  return (
    <div className={clsx('space-y-4', className)}>
      {!frame ? (
        `Loading frame ${frameId}...`
      ) : (
        <>
          <div className="flex space-x-2">
            <div className="flex-1"></div>
            <Button
              type="button"
              size="small"
              color="secondary"
              className="flex-0"
              onClick={() => {
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
              }}
            >
              Import .json
            </Button>
            <Button
              type="button"
              size="small"
              color="secondary"
              className="flex-0"
              onClick={() => {
                downloadJson(frame, `${frame.name || `frame-${frame.id}`}.json`)
              }}
            >
              Export .json
            </Button>
            <Button
              type="button"
              size="small"
              color="secondary"
              className="flex-0"
              onClick={() => {
                if (confirm('Are you sure you want to DELETE this frame?')) {
                  deleteFrame(frame.id)
                }
              }}
            >
              <span className="text-red-300">Delete frame</span>
            </Button>
          </div>
          <Form formKey="frameForm" logic={frameLogic} props={{ frameId }} className="space-y-4" enableFormOnSubmit>
            <Field name="name" label="Name">
              <TextInput name="name" placeholder="Hallway frame" required />
            </Field>
            <Field name="device" label="Device">
              <Select name="device" options={devices} />
            </Field>
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
                    Please note that frames are currenly accessed over unsecured HTTP. You can still capture the key by
                    intercepting network traffic. More secure methods are planned.
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
            <Field name="rotate" label="Rotate">
              <Select
                name="rotate"
                options={[
                  { value: '0', label: '0 degrees' },
                  { value: '90', label: '90 degrees' },
                  { value: '180', label: '180 degrees' },
                  { value: '270', label: '270 degrees' },
                ]}
              />
            </Field>
            <Field
              name="log_to_file"
              label={<div>Save logs to file</div>}
              labelRight={
                <Button
                  color="secondary"
                  size="small"
                  onClick={() => {
                    setFrameFormValues({ log_to_file: '/srv/frameos/logs/frame.log' })
                    touchFrameFormField('log_to_file')
                  }}
                >
                  Set default
                </Button>
              }
              tooltip="This is disabled by default to save the SD card from wear."
            >
              <TextInput
                name="log_to_file"
                onClick={() => touchFrameFormField('log_to_file')}
                type="text"
                placeholder="e.g. /srv/frameos/logs/frame.log"
                required
              />
            </Field>{' '}
            <Field name="debug" label="Debug logging (noisy)">
              <Select
                name="debug"
                options={[
                  { value: 'false', label: 'Disabled' },
                  { value: 'true', label: 'Enabled' },
                ]}
              />
            </Field>
          </Form>
        </>
      )}
    </div>
  )
}
FrameSettings.PanelTitle = function FrameSettingsPanelTitle(): JSX.Element {
  return <>Settings</>
}
