import { Field, Form } from 'kea-forms'
import { framesLogic } from './framesLogic'
import { Box } from '../../components/Box'
import { Button } from '../../components/Button'
import { H6 } from '../../components/H6'

export function NewFrame(): JSX.Element {
  return (
    <Box id="add-frame" className="p-4">
      <Form logic={framesLogic} formKey="newFrame" className="space-y-6" enableFormOnSubmit>
        <H6>Add a smart frame</H6>
        <div>
          <label htmlFor="host" className="block mb-2 text-sm font-medium text-white">
            IP address or hostname
          </label>
          <Field name="host">
            <input
              type="text"
              name="host"
              className="border text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full p-2.5 bg-gray-600 border-gray-500 placeholder-gray-400 text-white"
              placeholder="127.0.0.1"
              required
            />
          </Field>
        </div>
        <Button type="submit">Add Frame</Button>
      </Form>
    </Box>
  )
}
