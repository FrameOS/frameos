import { Form } from 'kea-forms'
import { Box } from '../../components/Box'
import { Button } from '../../components/Button'
import { H6 } from '../../components/H6'
import { TextInput } from '../../components/TextInput'
import { Field } from '../../components/Field'
import { newFrameForm } from './newFrameForm'
import { Select } from '../../components/Select'
import { useActions, useValues } from 'kea'
import { devices, devicesNixOS, buildrootPlatforms, nixosPlatforms } from '../../devices'
import { A } from 'kea-router'
import { urls } from '../../urls'
import { Spinner } from '../../components/Spinner'

function isLocalServer(host?: string): boolean {
  const localHostRegex = /^(localhost|0\.0\.0\.0|127\.0\.0\.1|\[::1\])(:\d+)?$/
  return !!host && localHostRegex.test(host)
}

export function NewFrame(): JSX.Element {
  const { hideForm, resetNewFrame, setNewFrameValue, setNewFrameValues, setFile, importFrame } =
    useActions(newFrameForm)
  const { newFrame, file, importingFrameLoading } = useValues(newFrameForm)
  const mode = newFrame.mode

  return (
    <>
      <H6 className="mb-4">Add a smart frame</H6>
      <Box id="add-frame" className="p-4 w-80 max-w-full">
        <div className="flex gap-2 mb-4">
          <Button
            size="small"
            color={mode === 'rpios' ? 'primary' : 'secondary'}
            onClick={() => {
              setNewFrameValues({ mode: 'rpios', platform: null })
            }}
          >
            RPi OS
          </Button>
          <Button
            size="small"
            color={mode === 'nixos' ? 'primary' : 'secondary'}
            onClick={() => {
              setNewFrameValues({ mode: 'nixos', platform: 'pi-zero2' })
            }}
          >
            NixOS (alpha)
          </Button>
          <Button
            size="small"
            color={mode === 'buildroot' ? 'primary' : 'secondary'}
            onClick={() => {
              setNewFrameValues({ mode: 'buildroot', platform: '' })
            }}
          >
            Buildroot (alpha)
          </Button>
          <Button
            size="small"
            color={mode === 'import' ? 'primary' : 'secondary'}
            onClick={() => setNewFrameValue('mode', 'import')}
          >
            Import JSON
          </Button>
        </div>
        {mode === 'rpios' ? (
          <Form logic={newFrameForm} formKey="newFrame" className="space-y-4" enableFormOnSubmit>
            <p className="text-sm text-gray-500">
              Enter the credentials of a running Raspberry Pi OS Lite (Bookworm) machine here. We will then deploy
              FrameOS over SSH.
            </p>
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
            <Field name="server_host" label="Backend IP or hostname for reverse access">
              {({ value, onChange }) => (
                <>
                  <TextInput name="server_host" placeholder="127.0.0.1" required value={value} onChange={onChange} />
                  {isLocalServer(value) ? (
                    <p className="text-sm">
                      <span className="text-yellow-500">Warning!</span> Set this to the real host/IP of this server, not
                      to "localhost". The frame needs to use it to connect back to the backend.
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
        ) : mode === 'nixos' ? (
          <Form logic={newFrameForm} formKey="newFrame" className="space-y-4" enableFormOnSubmit>
            <p className="text-sm text-yellow-500">
              This mode is <strong>under active development</strong>. Your frames could break with any new update, so
              proceed with caution and take backups! Not all devices are supported yet.
            </p>
            <p className="text-sm text-gray-500">
              Steps: 1) add your frame, 2) add scenes to it, 3) download a SD card image, 4) flash it, 5) boot
            </p>
            <Field name="name" label="Name">
              <TextInput name="name" placeholder="Kitchen Frame" required />
            </Field>
            <Field name="server_host" label="Backend IP or hostname for reverse access">
              {({ value, onChange }) => (
                <>
                  <TextInput name="server_host" placeholder="127.0.0.1" required value={value} onChange={onChange} />
                  {isLocalServer(value) ? (
                    <p className="text-sm">
                      <span className="text-yellow-500">Warning!</span> Set this to the real host/IP of this server, not
                      to "localhost". The frame needs to use it to connect back to the backend.
                    </p>
                  ) : null}
                </>
              )}
            </Field>
            <Field name="device" label="Driver">
              <Select name="device" options={devicesNixOS} />
            </Field>
            <Field name="platform" label="Platform">
              <Select name="platform" options={nixosPlatforms} />
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
        ) : mode === 'buildroot' ? (
          <Form logic={newFrameForm} formKey="newFrame" className="space-y-4" enableFormOnSubmit>
            <p className="text-sm text-yellow-500">
              Buildroot images bundle a full FrameOS runtime into a dedicated firmware image. Support is still evolving,
              so expect rough edges while we iterate.
            </p>
            <p className="text-sm text-gray-500">
              Steps: 1) add your frame, 2) configure scenes, 3) download or provision the Buildroot image, 4) flash it,
              5) boot.
            </p>
            <Field name="name" label="Name">
              <TextInput name="name" placeholder="Kitchen Frame" required />
            </Field>
            <Field name="server_host" label="Backend IP or hostname for reverse access">
              {({ value, onChange }) => (
                <>
                  <TextInput name="server_host" placeholder="127.0.0.1" required value={value} onChange={onChange} />
                  {isLocalServer(value) ? (
                    <p className="text-sm">
                      <span className="text-yellow-500">Warning!</span> Set this to the real host/IP of this server, not
                      to "localhost". The frame needs to use it to connect back to the backend.
                    </p>
                  ) : null}
                </>
              )}
            </Field>
            <Field name="device" label="Driver">
              <Select name="device" options={devices} />
            </Field>
            <Field name="platform" label="Platform">
              <Select name="platform" options={buildrootPlatforms} />
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
