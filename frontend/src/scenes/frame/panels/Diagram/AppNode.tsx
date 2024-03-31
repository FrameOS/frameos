import { useActions, useValues } from 'kea'
import { NodeProps, Handle, Position } from 'reactflow'
import { AppNodeData, DispatchNodeData } from '../../../../types'
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

export function AppNode({ data, id, isConnectable }: NodeProps<AppNodeData | DispatchNodeData>): JSX.Element {
  const { frameId, sceneId, sceneOptions } = useValues(diagramLogic)
  const { updateNodeConfig, copyAppJSON, deleteApp } = useActions(diagramLogic)
  const { editApp } = useActions(panelsLogic)
  const appNodeLogicProps = { frameId, sceneId, nodeId: id }
  const { isDispatch, name, fields, isCustomApp, configJsonError, isSelected, codeFields, fieldInputFields } =
    useValues(appNodeLogic(appNodeLogicProps))
  const [secretRevealed, setSecretRevealed] = useState<Record<string, boolean>>({})

  return (
    <div
      className={clsx(
        'shadow-lg border-2',
        isSelected
          ? 'bg-black bg-opacity-70 border-indigo-900 shadow-indigo-700/50'
          : isDispatch
          ? 'bg-black bg-opacity-70 border-green-900 shadow-green-700/50 '
          : isCustomApp
          ? 'bg-black bg-opacity-70 border-teal-900 shadow-teal-700/50 '
          : 'bg-black bg-opacity-70 border-sky-900 shadow-sky-700/50 '
      )}
    >
      <div
        className={clsx(
          'frameos-node-title text-xl p-1 px-2 gap-2',
          isSelected ? 'bg-indigo-900' : isDispatch ? 'bg-green-900' : isCustomApp ? 'bg-teal-900' : 'bg-sky-900',
          'flex w-full justify-between items-center'
        )}
      >
        <Handle
          type="target"
          position={Position.Left}
          id="prev"
          style={{
            position: 'relative',
            transform: 'none',
            left: 0,
            top: 0,
            width: 20,
            height: 20,
            background: 'rgba(180, 180, 180, 0.8)',
            borderBottomLeftRadius: 0,
            borderTopLeftRadius: 0,
          }}
          isConnectable={isConnectable}
        />{' '}
        <div className="flex-1">
          {name}
          {isCustomApp ? ' (edited)' : ''}
        </div>
        <DropdownMenu
          className="w-fit"
          buttonColor="none"
          horizontal
          items={[
            ...(isDispatch
              ? []
              : [
                  {
                    label: 'Edit App',
                    onClick: () => editApp(sceneId, id, data),
                    icon: <PencilSquareIcon className="w-5 h-5" />,
                  },
                ]),
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
        <Handle
          type="source"
          position={Position.Right}
          id="next"
          style={{
            position: 'relative',
            transform: 'none',
            width: 20,
            height: 20,
            right: 0,
            top: 0,
            background: 'rgba(200, 200, 200, 0.8)',
            borderBottomLeftRadius: 0,
            borderTopLeftRadius: 0,
          }}
          isConnectable={isConnectable}
        />
      </div>
      {configJsonError !== null ? (
        <div className="text-red-400 p-1">
          Error parsing config.json:
          <br />
          {configJsonError}
        </div>
      ) : null}
      {fields && fields.length > 0 ? (
        <div className="p-1">
          <table className="table-auto border-separate border-spacing-x-1 border-spacing-y-0.5 w-full">
            <tbody>
              {fields.map((field, i) => (
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
                        {field.type !== 'node' ? (
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
                            isConnectable
                          />
                        ) : null}
                      </td>
                      <td
                        className={clsx(
                          'font-sm text-indigo-200',
                          field.type === 'node' ||
                            codeFields.includes(field.name) ||
                            fieldInputFields.includes(field.name)
                            ? 'w-full'
                            : '',
                          codeFields.includes(field.name) ||
                            fieldInputFields.includes(field.name) ||
                            (field.name in data.config && data.config[field.name] !== field.value)
                            ? 'underline font-bold'
                            : ''
                        )}
                        title={
                          field.name in data.config && data.config[field.name] !== field.value
                            ? `${field.name} has been modified`
                            : undefined
                        }
                        colSpan={
                          field.type === 'node' ||
                          codeFields.includes(field.name) ||
                          fieldInputFields.includes(field.name)
                            ? 2
                            : 1
                        }
                      >
                        <div className="flex justify-between items-center gap-2">
                          <div>{field.label ?? field.name}</div>
                        </div>
                      </td>
                      {field.type !== 'node' &&
                      !codeFields.includes(field.name) &&
                      !fieldInputFields.includes(field.name) ? (
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
                          ) : field.type === 'scene' ? (
                            <Select
                              theme="node"
                              placeholder={field.placeholder}
                              value={field.name in data.config ? data.config[field.name] : field.value}
                              options={sceneOptions}
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
                          ) : field.type === 'boolean' ? (
                            <input
                              type="checkbox"
                              checked={(field.name in data.config ? data.config[field.name] : field.value) == 'true'}
                              onChange={(e) => updateNodeConfig(id, field.name, e.target.checked ? 'true' : 'false')}
                            />
                          ) : (
                            <TextInput
                              theme="node"
                              placeholder={field.placeholder}
                              value={String((field.name in data.config ? data.config[field.name] : field.value) ?? '')}
                              onChange={(value) => updateNodeConfig(id, field.name, value)}
                              className={field.type === 'color' ? '!min-w-[50px]' : ''}
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
                              borderBottomLeftRadius: 0,
                              borderTopLeftRadius: 0,
                            }}
                            isConnectable={isConnectable}
                          />
                        ) : (
                          <Handle
                            type="source"
                            position={Position.Right}
                            id={`field/${field.name}`}
                            style={{ position: 'relative', transform: 'none', right: 0, top: 0, background: '#000000' }}
                          />
                        )}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}
