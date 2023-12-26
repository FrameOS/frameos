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
import { panelsLogic } from '../panelsLogic'
import { DropdownMenu } from '../../../../components/DropdownMenu'
import { Markdown } from '../../../../components/Markdown'
import { ClipboardDocumentIcon, PencilSquareIcon, TrashIcon } from '@heroicons/react/24/solid'
import { appNodeLogic } from './appNodeLogic'

export function AppNode({ data, id, isConnectable }: NodeProps<AppNodeData>): JSX.Element {
  const { frameId, sceneId } = useValues(diagramLogic)
  const { updateNodeConfig, copyAppJSON, deleteApp } = useActions(diagramLogic)
  const { editApp } = useActions(panelsLogic)
  const appNodeLogicProps = { frameId, sceneId, nodeId: id }
  const { app, appFields, isCustomApp, configJsonError, isSelected, node } = useValues(appNodeLogic(appNodeLogicProps))
  const [secretRevealed, setSecretRevealed] = useState<Record<string, boolean>>({})

  return (
    <div
      className={clsx(
        'shadow-lg border border-2',
        isSelected
          ? 'bg-black bg-opacity-70 border-indigo-900 shadow-indigo-700/50'
          : isCustomApp
          ? 'bg-black bg-opacity-70 border-teal-900 shadow-teal-700/50 '
          : 'bg-black bg-opacity-70 border-sky-900 shadow-sky-700/50 '
      )}
    >
      <div
        className={clsx(
          'text-xl p-1 gap-1',
          isSelected ? 'bg-indigo-900' : isCustomApp ? 'bg-teal-900' : 'bg-sky-900',
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
              icon: <PencilSquareIcon className="w-5 h-5" />,
            },
            {
              label: 'Copy as JSON',
              onClick: () => copyAppJSON(id),
              icon: <ClipboardDocumentIcon className="w-5 h-5" />,
            },
            {
              label: 'Delete Node',
              onClick: () => deleteApp(id),
              icon: <TrashIcon className="w-5 h-5" />,
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
        {appFields ? (
          <table className="table-auto border-separate border-spacing-x-1 border-spacing-y-0.5">
            <tbody>
              {appFields.map((field, i) => (
                <React.Fragment key={i}>
                  {'markdown' in field ? (
                    <tr>
                      <td className={clsx('font-sm text-indigo-200')} colSpan={4}>
                        <Markdown value={field.markdown} />
                      </td>
                    </tr>
                  ) : (
                    <tr>
                      <td>
                        <Handle
                          type="target"
                          position={Position.Left}
                          id={`fieldInput/${field.name}`}
                          style={{
                            position: 'relative',
                            transform: 'none',
                            left: 0,
                            top: 0,
                            background: 'black',
                            borderColor: 'white',
                          }}
                          onConnect={(params) => console.log('handle onConnect', params)}
                          isConnectable
                        />
                      </td>
                      <td
                        className={clsx(
                          'font-sm text-indigo-200',
                          field.name in data.config && data.config[field.name] !== field.value
                            ? 'underline font-bold'
                            : ''
                        )}
                        title={
                          field.name in data.config && data.config[field.name] !== field.value
                            ? `${field.name} has been modified`
                            : undefined
                        }
                        colSpan={field.type === 'node' ? 2 : 1}
                      >
                        <div className="flex justify-between items-center gap-2">
                          <div>{field.label ?? field.name}</div>
                        </div>
                      </td>
                      {field.type !== 'node' ? (
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
                              type={
                                field.type === 'integer' || field.type === 'float'
                                  ? 'tel'
                                  : field.type === 'color'
                                  ? 'color'
                                  : 'text'
                              }
                            />
                          )}
                        </td>
                      ) : null}
                      <td>
                        {field.type === 'node' ? (
                          <Handle
                            type="source"
                            position={Position.Right}
                            id={`field/${field.name}`}
                            style={{
                              position: 'relative',
                              transform: 'none',
                              right: 0,
                              top: 0,
                              background: '#cccccc',
                            }}
                            isConnectable={isConnectable}
                          />
                        ) : null}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </div>
  )
}
