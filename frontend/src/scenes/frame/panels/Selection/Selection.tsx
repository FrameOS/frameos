import { frameLogic } from '../../frameLogic'
import { useValues } from 'kea'
import { RevealDots } from '../../../../components/Reveal'
import { H6 } from '../../../../components/H6'

export function Selection() {
  const { selectedApp } = useValues(frameLogic)
  const fields = Object.fromEntries((selectedApp?.fields || []).map((field) => [field.name, field]))

  return (
    <div>
      <H6>{selectedApp?.name}</H6>
      {selectedApp?.config ? (
        <table className="table-auto border-separate border-spacing-x-1 border-spacing-y-0.5">
          <tbody>
            {Object.entries(selectedApp.config).map(([key, value]) => (
              <tr key={key}>
                <td className="font-sm text-indigo-200">{key}</td>
                <td>{fields[key]?.secret ? <RevealDots /> : value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  )
}
