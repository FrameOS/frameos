import { Form } from 'kea-forms'
import { Box } from '../../components/Box'
import { Button } from '../../components/Button'
import { H6 } from '../../components/H6'
import { TextInput } from '../../components/TextInput'
import { Field } from '../../components/Field'
import { newFrameForm } from './newFrameForm'
import { Select } from '../../components/Select'
import { useActions, useValues } from 'kea'
import { devices } from '../../devices'

export function NewFrame(): JSX.Element {
  const { hideForm, resetNewFrame } = useActions(newFrameForm)
  return (
    <>
      <H6 className="mb-4">Add a smart frame</H6>
      <Box id="add-frame" className="p-4 w-80 max-w-full">
        <Form logic={newFrameForm} formKey="newFrame" className="space-y-4" enableFormOnSubmit>
          <Field name="name" label="Name">
            <TextInput name="name" placeholder="Kitchen Frame" required />
          </Field>
          <Field name="frame_host" label="IP address or hostname">
            <TextInput name="frame_host" placeholder="user:pass@127.0.0.1" required />
          </Field>
          <Field name="server_host" label="Controller IP or hostname for reverse access">
            <TextInput name="server_host" placeholder="127.0.0.1" required />
          </Field>
          <Field name="device" label="Driver">
            <Select name="device" options={devices} />
          </Field>
          <Field
            name="interval"
            label="Refresh interval in seconds"
            tooltip={
              <>
                How often do we trigger a refresh, in seconds. Pass a large number like "60" or even more for e-ink
                frames. A number below 1 activates realtime mode (0.041s = 24fps, 0.016s = 60fps). This should be used
                when you're certain of your setup and only if your hardware supports it.
              </>
            }
          >
            <TextInput name="interval" />
          </Field>
          <div className="flex gap-2">
            <Button type="submit">Add Frame</Button>
            <Button
              color="secondary"
              onClick={() => {
                resetNewFrame()
                hideForm()
              }}
            >
              Cancel
            </Button>
          </div>
        </Form>
      </Box>
    </>
  )
}
