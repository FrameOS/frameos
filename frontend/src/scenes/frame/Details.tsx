import { useActions, useValues } from 'kea'
import { Box } from '../../components/Box'
import { H6 } from '../../components/H6'
import { frameLogic } from './frameLogic'
import clsx from 'clsx'
import { Button } from '../../components/Button'
import { frameHost, frameStatus } from '../../decorators/frame'
import { Form } from 'kea-forms'
import { Reveal } from '../../components/Reveal'

export interface DetailsProps {
  className?: string
}

export function Details({ className }: DetailsProps) {
  const { frame, frameLoading } = useValues(frameLogic)

  return (
    <Box className={clsx('p-4 space-y-4', className)}>
      <H6>Details</H6>
      {frameLoading ? (
        '...'
      ) : (
        <>
          <Form logic={frameLogic} formKey="frame" enableFormOnSubmit className="space-y-6">
            <table className="table-auto border-separate border-spacing-x-1 border-spacing-y-0.5">
              <tbody>
                <tr>
                  <td className="text-blue-200 text-right">SSH host:</td>
                  <td>{frame.host}</td>
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
                  <td>{frame.api_host}</td>
                </tr>
                <tr>
                  <td className="text-blue-200 text-right">API key:</td>
                  <td>
                    <Reveal>{frame.api_key}</Reveal>
                  </td>
                </tr>
                <tr>
                  <td className="text-blue-200 text-right">API port:</td>
                  <td>{frame.api_port}</td>
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
              </tbody>
            </table>
            <Button type="submit">Redeploy</Button>
          </Form>
        </>
      )}
    </Box>
  )
}
