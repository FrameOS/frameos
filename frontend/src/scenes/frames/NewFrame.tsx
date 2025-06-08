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
import { A } from 'kea-router'
import { urls } from '../../urls'
import { Spinner } from '../../components/Spinner'

function isLocalServer(host?: string): boolean {
  const localHostRegex = /^(localhost|0\.0\.0\.0|127\.0\.0\.1|\[::1\])(:\d+)?$/
  return !!host && localHostRegex.test(host)
}

export function NewFrame(): JSX.Element {
  const { hideForm, resetNewFrame, setMode, setFile, importFrame } = useActions(newFrameForm)
  const { mode, file, importingFrameLoading } = useValues(newFrameForm)

  return (
    <>
      <H6 className="mb-4">Add a smart frame</H6>
      <Box id="add-frame" className="p-4 w-80 max-w-full">
        <div className="flex gap-2 mb-4">
          <Button size="small" color={mode === 'create' ? 'primary' : 'secondary'} onClick={() => setMode('create')}>
            New
          </Button>
          <Button size="small" color={mode === 'import' ? 'primary' : 'secondary'} onClick={() => setMode('import')}>
            Import JSON
          </Button>
        </div>
        {mode === 'create' ? (
          <Form logic={newFrameForm} formKey="newFrame" className="space-y-4" enableFormOnSubmit>
            <Field name="name" label="Name">
              <TextInput name="name" placeholder="Kitchen Frame" required />
            </Field>
            <Field
              name="frame_host"
              label={
                <>
                  SSH connection string{' '}
                  <A href={urls.settings()} className="text-blue-400 hover:underline">
                    (setup keys)
                  </A>
                </>
              }
            >
              <TextInput name="frame_host" placeholder="user:pass@127.0.0.1" required />
            </Field>
            <Field name="server_host" label="Controller IP or hostname for reverse access">
              {({ value, onChange }) => (
                <>
                  <TextInput name="server_host" placeholder="127.0.0.1" required value={value} onChange={onChange} />
                  {isLocalServer(value) ? (
                    <p className="text-sm">
                      <span className="text-orange-500">Warning!</span> Set this to the real IP of this computer, not to
                      "localhost". The frame needs to use it to connect back to the backend.
                    </p>
                  ) : null}
                </>
              )}
            </Field>
            <Field name="device" label="Driver">
              <Select name="device" options={devices} />
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
        ) : (
          <div className="space-y-4">
            <input type="file" accept=".json" onChange={(e) => setFile(e.target.files?.[0] || null)} />
            <div className="flex gap-2">
              <Button onClick={importFrame} disabled={!file}>
                {importingFrameLoading ? <Spinner /> : 'Import'}
              </Button>
              <Button
                color="secondary"
                onClick={() => {
                  setFile(null)
                  resetNewFrame()
                  hideForm()
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Box>
    </>
  )
}
