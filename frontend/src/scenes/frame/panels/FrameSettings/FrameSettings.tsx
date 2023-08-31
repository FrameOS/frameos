import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import { Button } from '../../../../components/Button'
import { framesModel } from '../../../../models/framesModel'
import { Field, Form } from 'kea-forms'
import { TextInput } from '../../../../components/TextInput'
import { Select } from '../../../../components/Select'
import { frameLogic } from '../../frameLogic'

export interface DetailsProps {
  className?: string
  id: number
}

export function FrameSettings({ className }: DetailsProps) {
  const { id, frame, frameFormTouches } = useValues(frameLogic)
  const { touchFrameFormField } = useActions(frameLogic)
  const { deleteFrame } = useActions(framesModel)

  return (
    <div className={clsx('space-y-4', className)}>
      {!frame ? (
        `Loading frame ${id}...`
      ) : (
        <>
          <div className="flex space-x-2">
            <div className="flex-1"></div>
            <div>
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
          </div>
          <Form formKey="frameForm" logic={frameLogic} props={{ id }} className="space-y-4" enableFormOnSubmit>
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
            <Field name="interval" label="Interval">
              <TextInput name="interval" placeholder="300" />
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
            <Field name="background_color" label="Background color">
              <TextInput name="background_color" placeholder="white" />
            </Field>
          </Form>
        </>
      )}
    </div>
  )
}
