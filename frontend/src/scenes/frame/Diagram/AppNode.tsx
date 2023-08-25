import { useValues } from 'kea'
import { NodeProps, Handle, Position } from 'reactflow'
import { frameLogic } from '../frameLogic'
import { AppConfig } from '../../../types'
import clsx from 'clsx'

export function AppNode({ data, id, isConnectable }: NodeProps): JSX.Element {
  const { nodes, selectedNodeId } = useValues(frameLogic)

  const app: AppConfig = data.app
  return (
    <div
      className={clsx(
        'shadow-lg border border-2',
        selectedNodeId === id
          ? 'bg-indigo-950 border-indigo-900 shadow-indigo-700/50'
          : 'bg-sky-950 border-sky-900 shadow-sky-700/50 '
      )}
    >
      <Handle
        type="target"
        position={Position.Top}
        style={{ marginTop: -3 }}
        onConnect={(params) => console.log('handle onConnect', params)}
        isConnectable={isConnectable}
      />
      <div className={clsx('text-xl p-1', selectedNodeId === id ? 'bg-indigo-900' : 'bg-sky-900')}>{app.name}</div>
      {app.config ? (
        <div className="p-1">
          <table className="table-auto border-separate border-spacing-x-1 border-spacing-y-0.5">
            <tbody>
              {Object.entries(app.config).map(([key, value]) => (
                <tr key={key}>
                  <td className="font-sm text-indigo-200">{key}</td>
                  <td>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <Handle
        type="source"
        position={Position.Bottom}
        id="a"
        style={{ marginBottom: -3 }}
        isConnectable={isConnectable}
      />
    </div>
  )
}
