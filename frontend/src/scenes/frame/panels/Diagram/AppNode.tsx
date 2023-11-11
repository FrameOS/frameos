import { useActions, useValues } from 'kea'
import { NodeProps, Handle, Position } from 'reactflow'
import { App, AppNodeData } from '../../../../types'
import clsx from 'clsx'
import { RevealDots } from '../../../../components/Reveal'
import { diagramLogic } from './diagramLogic'
import { TextInput } from '../../../../components/TextInput'
import { Select } from '../../../../components/Select'
import React, { useState } from 'react'
import { TextArea } from '../../../../components/TextArea'
import { PencilSquare } from '../../../../icons/icons'
import { panelsLogic } from '../panelsLogic'
import { DropdownMenu } from '../../../../components/DropdownMenu'

export function AppNode({ data, id, isConnectable }: NodeProps<AppNodeData>): JSX.Element {
  const { apps, frameId, selectedNodeId, sceneId } = useValues(diagramLogic)
  const { updateNodeConfig, copyAppJSON } = useActions(diagramLogic)
  const [secretRevealed, setSecretRevealed] = useState<Record<string, boolean>>({})
  const { editApp } = useActions(panelsLogic({ id: frameId }))

  const sourceConfigJson = data?.sources?.['config.json']
  let configJson: App | null = null
  let configJsonError: string | null = null
  try {
    configJson = JSON.parse(sourceConfigJson || 'null')
  } catch (e) {
    configJsonError = e instanceof Error ? e.message : String(e)
  }
  const app: App | undefined = configJson || apps[data.keyword]
  const isCustomApp = !!data?.sources

  return (
    <div
      className={clsx(
        'shadow-lg border border-2',
        selectedNodeId === id
          ? 'bg-black bg-opacity-70 border-indigo-900 shadow-indigo-700/50'
          : isCustomApp
          ? 'bg-black bg-opacity-70 border-teal-900 shadow-teal-700/50 '
          : 'bg-black bg-opacity-70 border-sky-900 shadow-sky-700/50 '
      )}
    >
      <div
        className={clsx(
          'text-xl p-1 gap-1',
          selectedNodeId === id ? 'bg-indigo-900' : isCustomApp ? 'bg-teal-900' : 'bg-sky-900',
          'flex w-full justify-between items-center'
        )}
      >
        <div>
          {app?.name}
          {isCustomApp ? ' (edited)' : ''}
        </div>
        <DropdownMenu
          className="w-fit"
          items={[
            {
              label: 'Edit App',
              onClick: () => editApp(sceneId, id, data),
              icon: <PencilSquare />,
            },
            {
              label: 'Copy as JSON',
              onClick: () => copyAppJSON(id),
              icon: <PencilSquare />,
            },
          ]}
        />
      </div>
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
        {configJsonError !== null ? (
          <div className="text-red-400">
            Error parsing config.json:
            <br />
            {configJsonError}
          </div>
        ) : null}
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
                    {field.label ?? field.name}
                  </td>
                  <td className="cursor-text">
                    {field.secret && !secretRevealed[field.name] ? (
                      <RevealDots onClick={() => setSecretRevealed({ ...secretRevealed, [field.name]: true })} />
                    ) : field.type === 'select' ? (
                      <Select
                        theme="node"
                        placeholder={field.placeholder}
                        value={field.name in data.config ? data.config[field.name] : field.value}
                        options={(field.options ?? []).map((o) => ({ value: o, label: o }))}
                        onChange={(value) => updateNodeConfig(id, field.name, value)}
                      />
                    ) : field.type === 'text' ? (
                      <TextArea
                        theme="node"
                        placeholder={field.placeholder}
                        value={String((field.name in data.config ? data.config[field.name] : field.value) ?? '')}
                        onChange={(value) => updateNodeConfig(id, field.name, value)}
                        rows={field.rows ?? 3}
                      />
                    ) : (
                      <TextInput
                        theme="node"
                        placeholder={field.placeholder}
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
