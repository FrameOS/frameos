import { Field, Form } from 'kea-forms'
import { framesLogic } from './framesLogic'

export function NewFrame(): JSX.Element {
  return (
    <div
      id="add-frame"
      className="w-full p-4 bg-white border border-gray-200 rounded-lg shadow sm:p-6 md:p-8 dark:bg-gray-800 dark:border-gray-700"
    >
      <Form logic={framesLogic} formKey="newFrame" className="space-y-6" enableFormOnSubmit>
        <h5 className="text-xl font-medium text-gray-900 dark:text-white">Add a smart frame</h5>
        <div>
          <label htmlFor="ip" className="block mb-2 text-sm font-medium text-gray-900 dark:text-white">
            IP address or hostname
          </label>
          <Field name="ip">
            <input
              type="ip"
              name="ip"
              id="ip"
              className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full p-2.5 dark:bg-gray-600 dark:border-gray-500 dark:placeholder-gray-400 dark:text-white"
              placeholder="127.0.0.1"
              required
            />
          </Field>
        </div>
        <button
          type="submit"
          className="w-full text-white bg-blue-700 hover:bg-blue-800 focus:ring-4 focus:outline-none focus:ring-blue-300 font-medium rounded-lg text-sm px-5 py-2.5 text-center dark:bg-blue-600 dark:hover:bg-blue-700 dark:focus:ring-blue-800"
        >
          Add Frame
        </button>
      </Form>
    </div>
  )
}
