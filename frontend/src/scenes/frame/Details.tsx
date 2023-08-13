import { useActions, useValues } from 'kea'
import { Box } from '../../components/Box'
import { H6 } from '../../components/H6'
import clsx from 'clsx'
import { Button } from '../../components/Button'
import { frameStatus, frameUrl } from '../../decorators/frame'
import { Reveal } from '../../components/Reveal'
import { framesModel } from '../../models/framesModel'
import { frameLogic } from './frameLogic'
import { Field, Form } from 'kea-forms'
import { TextInput } from '../../components/TextInput'

export interface DetailsProps {
  className?: string
  id: number
}

export function Details({ className, id }: DetailsProps) {
  const { frame, editing } = useValues(frameLogic({ id }))
  const { editFrame, closeEdit, setEditFrameValue } = useActions(frameLogic({ id }))
  const { redeployFrame, refreshFrame, restartFrame, deleteFrame } = useActions(framesModel)

  return (
    <Box className={clsx('p-4 space-y-4', className)}>
      {!frame ? (
        `Loading frame ${id}...`
      ) : editing ? (
        <>
          <H6>Edit frame</H6>
          <Form formKey="editFrame" logic={frameLogic} props={{ id }} className="space-y-4" enableFormOnSubmit>
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
              <TextInput name="ssh_pass" placeholder="raspberry" />
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
              <TextInput name="server_api_key" placeholder="" required />
            </Field>
            <Field name="image_url" label="Image URL">
              <TextInput name="image_url" placeholder="https://source.unsplash.com/random/{width}x{height}/?bird" />
            </Field>
            <div className="space-x-2">
              <span>Unsplash:</span>
              <a
                href="#"
                className="underline"
                onClick={(e) => {
                  setEditFrameValue('image_url', 'https://source.unsplash.com/random/{width}x{height}/?bird')
                  e.preventDefault()
                }}
              >
                random birds
              </a>
              <a
                href="#"
                className="underline"
                onClick={(e) => {
                  setEditFrameValue('image_url', 'https://source.unsplash.com/random/{width}x{height}/?fruit')
                  e.preventDefault()
                }}
              >
                random fruit
              </a>
            </div>
            <Field name="interval" label="Interval">
              <TextInput name="interval" placeholder="300" />
            </Field>
            <div className="flex space-x-2">
              <Button type="submit">Save & restart</Button>
              <Button
                type="button"
                onClick={() => closeEdit()}
                className="bg-gray-600 hover:bg-gray-700 focus:ring-gray-800"
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => {
                  if (confirm('Are you sure you want to DELETE this frame?')) {
                    deleteFrame(frame.id)
                  }
                }}
                className="bg-red-600 hover:bg-red-700 focus:ring-red-800"
              >
                Delete
              </Button>
            </div>
          </Form>
        </>
      ) : (
        <>
          <div className="flex justify-between">
            <H6>Details</H6>
            <div className="flex-0">
              <Button onClick={() => editFrame(frame)}>Edit</Button>
            </div>
          </div>
          <table className="table-auto border-separate border-spacing-x-1 border-spacing-y-0.5">
            <tbody>
              <tr>
                <td className="text-blue-200 text-right">Frame host:</td>
                <td>{frame.frame_host}</td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">Frame port:</td>
                <td>{frame.frame_port}</td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">SSH user:</td>
                <td>{frame.ssh_user}</td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">SSH pass:</td>
                <td>
                  <Reveal>{frame.ssh_pass}</Reveal>
                </td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">SSH port:</td>
                <td>{frame.ssh_port}</td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">API host:</td>
                <td>{frame.server_host}</td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">API port:</td>
                <td>{frame.server_port}</td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">API key:</td>
                <td>
                  <Reveal>{frame.server_api_key}</Reveal>
                </td>
              </tr>
              {frame.version ? (
                <tr>
                  <td className="text-blue-200 text-right">Client version:</td>
                  <td>{frame.version}</td>
                </tr>
              ) : null}
              <tr>
                <td className="text-blue-200 text-right">Status:</td>
                <td>{frameStatus(frame)}</td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">Device:</td>
                <td>
                  {frame.device} {frame.color} {frame.width && frame.height ? `${frame.width}x${frame.height}` : ''}
                </td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">Interval:</td>
                <td className="truncate">{frame.interval}</td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">Image URL:</td>
                <td className="truncate">
                  <a href={frame.image_url} target="_blank" rel="noreferer noopener">
                    {frame.image_url}
                  </a>
                </td>
              </tr>
              <tr>
                <td className="text-blue-200 text-right">Kiosk URL:</td>
                <td className="truncate">
                  <a href={frameUrl(frame)} target="_blank" rel="noreferer noopener">
                    {frameUrl(frame)}
                  </a>
                </td>
              </tr>
            </tbody>
          </table>
          <div className="flex space-x-2">
            <Button type="button" onClick={() => redeployFrame(frame.id)}>
              Redeploy
            </Button>
            <Button type="button" onClick={() => restartFrame(frame.id)}>
              Restart
            </Button>
            <Button type="button" onClick={() => refreshFrame(frame.id)}>
              Refresh
            </Button>
          </div>
        </>
      )}
    </Box>
  )
}
