import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import { Button } from '../../../../components/Button'
import { framesModel } from '../../../../models/framesModel'
import { Form } from 'kea-forms'
import { TextInput } from '../../../../components/TextInput'
import { Select } from '../../../../components/Select'
import { frameLogic } from '../../frameLogic'
import { devices } from '../../constants'
import { downloadJson } from '../../../../utils/downloadJson'
import { Field } from '../../../../components/Field'

export interface DetailsProps {
  className?: string
  id: number
}

export function FrameSettings({ className }: DetailsProps) {
  const { id, frame, frameFormTouches } = useValues(frameLogic)
  const { touchFrameFormField, setFrameFormValues } = useActions(frameLogic)
  const { deleteFrame } = useActions(framesModel)

  return (
    <div className={clsx('space-y-4', className)}>
      {!frame ? (
        `Loading frame ${id}...`
      ) : (
        <>
          <div className="flex space-x-2">
            <div className="flex-1"></div>
            <Button
              type="button"
              size="small"
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
              className="flex-0"
              onClick={() => {
                downloadJson(frame, `${frame.name || `frame-${frame.id}`}.json`)
              }}
            >
              Export .json
            </Button>
            <Button
              type="button"
              color="red"
              size="small"
              className="flex-0"
              onClick={() => {
                if (confirm('Are you sure you want to DELETE this frame?')) {
                  deleteFrame(frame.id)
                }
              }}
            >
              Delete frame
            </Button>
          </div>
          <Form formKey="frameForm" logic={frameLogic} props={{ id }} className="space-y-4" enableFormOnSubmit>
            <Field name="name" label="Name">
              <TextInput name="name" placeholder="Hallway frame" required />
            </Field>
            <Field name="frame_host" label="Frame host">
              <TextInput name="frame_host" placeholder="127.0.0.1" required />
            </Field>
            <Field name="frame_port" label="Frame port">
              <TextInput name="frame_port" placeholder="8999" required />
            </Field>
            <Field name="ssh_user" label="SSH user">
              <TextInput name="ssh_user" placeholder="pi" required />
            </Field>
            <Field name="ssh_pass" label="SSH pass">
              <TextInput
                name="ssh_pass"
                onClick={() => touchFrameFormField('ssh_pass')}
                type={frameFormTouches.ssh_pass ? 'text' : 'password'}
                placeholder="raspberry"
              />
            </Field>
            <Field name="ssh_port" label="SSH port">
              <TextInput name="ssh_port" placeholder="22" required />
            </Field>
            <Field name="server_host" label="Server host">
              <TextInput name="server_host" placeholder="localhost" required />
            </Field>
            <Field name="server_port" label="Server port">
              <TextInput name="server_port" placeholder="8999" required />
            </Field>
            <Field name="server_api_key" label="Server API key">
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
            <Field name="interval" label="Refresh interval in seconds">
              <TextInput name="interval" placeholder="300" />
            </Field>
            <Field name="metrics_interval" label="Metric reporting interval in seconds, 0 to disable">
              <TextInput name="metrics_interval" placeholder="60" />
            </Field>
            <Field name="device" label="Device">
              <Select name="device" options={devices} />
            </Field>
            <Field name="scaling_mode" label="Scaling mode">
              <Select
                name="scaling_mode"
                options={[
                  { value: 'cover', label: 'Cover' },
                  { value: 'contain', label: 'Contain' },
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
            <Field name="background_color" label="Background color">
              <TextInput name="background_color" placeholder="white" />
            </Field>
          </Form>
        </>
      )}
    </div>
  )
}
