import { Form } from 'kea-forms'
import { Box } from '../../components/Box'
import { Button } from '../../components/Button'
import { H6 } from '../../components/H6'
import { TextInput } from '../../components/TextInput'
import { Field } from '../../components/Field'
import { newFrameForm } from './newFrameForm'
import { Select } from '../../components/Select'
import { devices } from '../frame/constants'

export function NewFrame(): JSX.Element {
  return (
    <Box id="add-frame" className="p-4">
      <Form logic={newFrameForm} formKey="newFrame" className="space-y-4" enableFormOnSubmit>
        <H6>Add a smart frame</H6>
        <Field name="frame_host" label="IP address or hostname">
          <TextInput name="frame_host" placeholder="127.0.0.1" required />
        </Field>
        <Field name="server_host" label="API host for reverse access">
          <TextInput name="server_host" placeholder="127.0.0.1" required />
        </Field>
        <Field name="device" label="Driver">
          <Select name="device" options={devices} />
        </Field>
        <Button type="submit">Add Frame</Button>
      </Form>
    </Box>
  )
}
