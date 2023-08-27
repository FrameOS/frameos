import { useValues } from 'kea'
import { NodeProps, Handle, Position } from 'reactflow'
import { frameLogic } from '../../frameLogic'
import { AppConfig } from '../../../../types'
import clsx from 'clsx'
import { Reveal, RevealDots } from '../../../../components/Reveal'

export function AppNode({ data, id, isConnectable }: NodeProps): JSX.Element {
  const { nodes, selectedNodeId } = useValues(frameLogic)

  const app: AppConfig = data.app
  const fields = Object.fromEntries((app.fields || []).map((field) => [field.name, field]))

  return (
    <div
      className={clsx(
        'shadow-lg border border-2',
        selectedNodeId === id
          ? 'bg-black border-indigo-900 shadow-indigo-700/50'
          : 'bg-black border-sky-900 shadow-sky-700/50 '
      )}
    >
      <div className={clsx('text-xl p-1', selectedNodeId === id ? 'bg-indigo-900' : 'bg-sky-900')}>{app.name}</div>
      <div className="p-1">
        <div className="flex justify-between">
          <div className="flex items-center space-x-1">
            <Handle
              type="target"
              position={Position.Left}
              style={{ position: 'relative', transform: 'none', left: 0, top: 0, background: 'white' }}
              onConnect={(params) => console.log('handle onConnect', params)}
              isConnectable={isConnectable}
            />
            <span>&nbsp;</span>
          </div>
          <div className="flex items-center space-x-1">
            <span>next step</span>
            <Handle
              type="source"
              position={Position.Right}
              id="a"
              style={{ position: 'relative', transform: 'none', right: 0, top: 0, background: '#cccccc' }}
              isConnectable={isConnectable}
            />
          </div>
        </div>
        {app.config ? (
          <table className="table-auto border-separate border-spacing-x-1 border-spacing-y-0.5">
            <tbody>
              {Object.entries(app.config).map(([key, value]) => (
                <tr key={key}>
                  <td className="font-sm text-indigo-200">{key}</td>
                  <td>{fields[key]?.secret ? <RevealDots /> : value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </div>
  )
}
