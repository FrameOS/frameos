import { useActions, useValues } from 'kea'
import { NodeProps, Handle, Position } from 'reactflow'
import { App, AppNodeData } from '../../../../types'
import clsx from 'clsx'
import { RevealDots } from '../../../../components/Reveal'
import { diagramLogic } from './diagramLogic'
import { Form, Group } from 'kea-forms'
import { frameLogic } from '../../frameLogic'
import { TextInput } from '../../../../components/TextInput'
import { Select } from '../../../../components/Select'
import { useState } from 'react'
import { TextArea } from '../../../../components/TextArea'

export function AppNode({ data, id, isConnectable }: NodeProps<AppNodeData>): JSX.Element {
  const { apps, selectedNodeId } = useValues(diagramLogic)
  const { updateNodeConfig } = useActions(diagramLogic)
  const app: App | undefined = apps[data.keyword]
  const [localRevealed, setLocalRevealed] = useState<Record<string, boolean>>({})

  return (
    <div
      className={clsx(
        'shadow-lg border border-2',
        selectedNodeId === id
          ? 'bg-black bg-opacity-70 border-indigo-900 shadow-indigo-700/50'
          : 'bg-black bg-opacity-70 border-sky-900 shadow-sky-700/50 '
      )}
    >
      <div className={clsx('text-xl p-1', selectedNodeId === id ? 'bg-indigo-900' : 'bg-sky-900')}>{app?.name}</div>
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
                <tr key={i}>
                  <td
                    className={clsx(
                      'font-sm text-indigo-200',
                      field.name in data.config && data.config[field.name] !== field.value ? 'underline font-bold' : ''
                    )}
                    title={
                      field.name in data.config && data.config[field.name] !== field.value
                        ? `${field.name} has been modified`
                        : undefined
                    }
                  >
                    {field.name}
                  </td>
                  <td className="cursor-text">
                    {field.secret && !localRevealed[field.name] ? (
                      <RevealDots onClick={() => setLocalRevealed({ ...localRevealed, [field.name]: true })} />
                    ) : field.type === 'select' ? (
                      <Select
                        theme="node"
                        value={field.name in data.config ? data.config[field.name] : field.value}
                        options={(field.options ?? []).map((o) => ({ value: o, label: o }))}
                        onChange={(value) => updateNodeConfig(id, field.name, value)}
                      />
                    ) : field.type === 'text' ? (
                      <TextArea
                        theme="node"
                        value={String((field.name in data.config ? data.config[field.name] : field.value) ?? '')}
                        onChange={(value) => updateNodeConfig(id, field.name, value)}
                      />
                    ) : (
                      <TextInput
                        theme="node"
                        value={String((field.name in data.config ? data.config[field.name] : field.value) ?? '')}
                        onChange={(value) => updateNodeConfig(id, field.name, value)}
                      />
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
