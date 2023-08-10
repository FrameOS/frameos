import { Form } from 'kea-forms'
import { framesLogic } from './framesLogic'
import { Box } from '../../components/Box'
import { Button } from '../../components/Button'
import { H6 } from '../../components/H6'
import { TextInput } from '../../components/TextInput'
import { Field } from '../../components/Field'

export function NewFrame(): JSX.Element {
  return (
    <Box id="add-frame" className="p-4">
      <Form logic={framesLogic} formKey="newFrame" className="space-y-4" enableFormOnSubmit>
        <H6>Add a smart frame</H6>
        <Field name="host" label="IP address or hostname">
          <TextInput name="host" placeholder="127.0.0.1" required />
        </Field>
        <Field name="api_host" label="API host for reverse access">
          <TextInput name="api_host" placeholder="127.0.0.1" required />
        </Field>
        <Button type="submit">Add Frame</Button>
      </Form>
    </Box>
  )
}
