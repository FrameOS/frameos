import { useActions, useValues } from 'kea'
import { NodeProps, Handle, Position } from 'reactflow'
import { App, AppNodeData } from '../../../../types'
import clsx from 'clsx'
import { RevealDots } from '../../../../components/Reveal'
import { diagramLogic } from './diagramLogic'

export function AppNode({ data, id, isConnectable }: NodeProps<AppNodeData>): JSX.Element {
  const { apps, selectedNodeId } = useValues(diagramLogic)
  const { updateNodeConfig } = useActions(diagramLogic)

  const app: App | undefined = apps[data.keyword]
  const fields = Object.fromEntries((app?.fields || []).map((field) => [field.name, field]))

  return (
    <div
      className={clsx(
        'shadow-lg border border-2',
        selectedNodeId === id
          ? 'bg-black bg-opacity-70 border-indigo-900 shadow-indigo-700/50'
          : 'bg-black bg-opacity-70 border-sky-900 shadow-sky-700/50 '
      )}
    >
      <div className={clsx('text-xl p-1', selectedNodeId === id ? 'bg-indigo-900' : 'bg-sky-900')}>{app.name}</div>
      <div className="p-1">
        <div className="flex justify-between">
          <div className="flex items-center space-x-1">
            <Handle
              type="target"
              position={Position.Left}
              id="prev"
              style={{ position: 'relative', transform: 'none', left: 0, top: 0, background: 'white' }}
              onConnect={(params) => console.log('handle onConnect', params)}
              isConnectable={isConnectable}
            />
            <span>&nbsp;</span>
          </div>
          <div className="flex items-center space-x-1">
            <Handle
              type="source"
              position={Position.Right}
              id="next"
              style={{ position: 'relative', transform: 'none', right: 0, top: 0, background: '#cccccc' }}
              isConnectable={isConnectable}
            />
          </div>
        </div>
        {app?.fields ? (
          <table className="table-auto border-separate border-spacing-x-1 border-spacing-y-0.5">
            <tbody>
              {app?.fields.map((field, i) => (
                <tr
                  key={i}
                  onDoubleClick={() => {
                    const value = !(field.name in data.config) ? String(field.value) : String(data.config[field.name])
                    const newValue = window.prompt(`Edit ${field.name}`, value)
                    if (typeof newValue === 'string') {
                      updateNodeConfig(id, field.name, newValue)
                    }
                  }}
                >
                  <td className="font-sm text-indigo-200">{field.name}</td>
                  <td>
                    {field.secret ? (
                      <RevealDots />
                    ) : !(field.name in data.config) ? (
                      String(field.value)
                    ) : (
                      String(data.config[field.name])
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </div>
  )
}
