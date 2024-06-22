import { BindLogic, useActions, useValues } from 'kea'
import { NodeProps, Handle, Position, NodeResizer } from 'reactflow'
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
import { NodeCache } from './NodeCache'
import { CodeArg } from './CodeArg'
import { newNodePickerLogic } from './newNodePickerLogic'
import { FieldTypeTag } from '../../../../components/FieldTypeTag'

export function AppNode({ id, isConnectable }: NodeProps<AppNodeData | DispatchNodeData>): JSX.Element {
  const { frameId, sceneId, sceneOptions } = useValues(diagramLogic)
  const { updateNodeConfig, copyAppJSON, deleteApp } = useActions(diagramLogic)
  const { editApp } = useActions(panelsLogic)
  const appNodeLogicProps = { frameId, sceneId, nodeId: id }
  const {
    node,
    nodeEdges,
    isDispatch,
    name,
    fields,
    isCustomApp,
    isDataApp,
    configJsonError,
    output,
    isSelected,
    codeArgs,
    fieldInputFields,
    nodeOutputFields,
    showOutput,
    showNextPrev,
  } = useValues(appNodeLogic(appNodeLogicProps))
  const data: AppNodeData = (node?.data as AppNodeData) ?? ({ keyword: '', config: {} } satisfies AppNodeData)
  const { select } = useActions(appNodeLogic(appNodeLogicProps))
  const { openNewNodePicker } = useActions(newNodePickerLogic({ sceneId, frameId }))
  const [secretRevealed, setSecretRevealed] = useState<Record<string, boolean>>({})

  const backgroundClassName = clsx(
    'shadow-lg border-2',
    isSelected
      ? 'bg-black bg-opacity-70 border-indigo-900 shadow-indigo-700/50'
      : isDispatch
      ? 'bg-black bg-opacity-70 border-orange-900 shadow-orange-700/50 '
      : isCustomApp
      ? 'bg-black bg-opacity-70 border-teal-900 shadow-teal-700/50 '
      : isDataApp
      ? 'bg-black bg-opacity-70 border-green-700 shadow-green-500/50 '
      : 'bg-black bg-opacity-70 border-sky-900 shadow-sky-700/50 '
  )

  const titleBackground = isSelected
    ? 'bg-indigo-900'
    : isDispatch
    ? 'bg-orange-900'
    : isCustomApp
    ? 'bg-teal-900'
    : isDataApp
    ? 'bg-green-700'
    : 'bg-sky-900'

  const titleClassName = clsx(
    'frameos-node-title text-xl p-1 px-2 gap-2',
    titleBackground,
    'flex w-full justify-between items-center'
  )

  return (
    <BindLogic logic={appNodeLogic} props={appNodeLogicProps}>
      <div onClick={select} className={backgroundClassName}>
        <NodeResizer minWidth={200} minHeight={130} />
        <div className={titleClassName}>
          {showNextPrev ? (
            <Handle
              // PrevNodeHandle
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
              onClick={(e) => {
                e.stopPropagation()
                openNewNodePicker(
                  e.clientX, // screenX
                  e.clientY, // screenY
                  (node?.position.x || 0) - 200, // diagramX
                  (node?.position.y || 0) + 20 + Math.random() * 60 - 30, // diagramY
                  id, // nodeId
                  'prev', // handleId
                  'target' // handleType
                )
              }}
            />
          ) : null}
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
          {showNextPrev ? (
            <Handle
              // NextNodeHandle
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
              onClick={(e) => {
                e.stopPropagation()
                openNewNodePicker(
                  e.clientX, // screenX
                  e.clientY, // screenY
                  (node?.position.x || 0) + (node?.width || 300) + 100 + Math.random() * 60, // diagramX
                  (node?.position.y || 0) + 20 + Math.random() * 60 - 30, // diagramY
                  id, // nodeId
                  'next', // handleId
                  'source' // handleType
                )
              }}
            />
          ) : null}
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
                {fields.map((field, i) => {
                  const hasChangedValue =
                    'name' in field &&
                    (codeArgs.includes(field.name) ||
                      fieldInputFields.includes(field.name) ||
                      nodeOutputFields.includes(field.name) ||
                      (field.name in data.config && data.config[field.name] !== field.value))

                  const isFieldWithInput =
                    'name' in field &&
                    field.type !== 'node' &&
                    field.type !== 'image' &&
                    !codeArgs.includes(field.name) &&
                    !fieldInputFields.includes(field.name)

                  return (
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
                                // AppInputHandle
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
                                onClick={(e) => {
                                  e.stopPropagation()
                                  const existingNodeCount = nodeEdges.filter((edge) =>
                                    edge.targetHandle?.startsWith('fieldInput/')
                                  ).length
                                  openNewNodePicker(
                                    e.clientX, // screenX
                                    e.clientY, // screenY
                                    (node?.position.x || 0) - existingNodeCount * 20, // diagramX
                                    (node?.position.y || 0) - 40 - existingNodeCount * 150, // diagramY
                                    id, // nodeId
                                    `fieldInput/${field.name}`, // handleId
                                    'target' // handleType
                                  )
                                }}
                              />
                            ) : null}
                          </td>
                          <td
                            className={clsx(
                              'font-sm text-indigo-200',
                              field.type === 'node' ||
                                codeArgs.includes(field.name) ||
                                fieldInputFields.includes(field.name) ||
                                nodeOutputFields.includes(field.name)
                                ? 'w-full'
                                : ''
                            )}
                            title={
                              field.name in data.config && data.config[field.name] !== field.value
                                ? `${field.name} has been modified`
                                : undefined
                            }
                            colSpan={
                              field.type === 'node' ||
                              field.type === 'image' ||
                              codeArgs.includes(field.name) ||
                              fieldInputFields.includes(field.name)
                                ? 2
                                : 1
                            }
                          >
                            <div
                              className={clsx(
                                'flex items-center gap-1',
                                !codeArgs.includes(field.name) &&
                                  !fieldInputFields.includes(field.name) &&
                                  field.type !== 'image'
                                  ? 'justify-between'
                                  : ''
                              )}
                            >
                              <div title={field.type} className={hasChangedValue ? 'underline font-bold' : ''}>
                                {field.label ?? field.name}
                              </div>
                              {field.type === 'node' ? (
                                <div className="flex items-center gap-2">
                                  <FieldTypeTag type={field.type} className={hasChangedValue ? 'font-bold' : ''} />
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
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      const existingNodeCount = nodeEdges.filter((edge) =>
                                        edge.targetHandle?.startsWith('fieldInput/')
                                      ).length
                                      openNewNodePicker(
                                        e.clientX, // screenX
                                        e.clientY, // screenY
                                        (node?.position.x || 0) + (node?.width || 300) + 20 + Math.random() * 30, // diagramX
                                        (node?.position.y || 0) + 30 + Math.random() * 80, // diagramY
                                        id, // nodeId
                                        `field/${field.name}`, // handleId
                                        'source' // handleType
                                      )
                                    }}
                                  />
                                </div>
                              ) : field.type !== 'boolean' ? (
                                <FieldTypeTag type={field.type} />
                              ) : null}
                            </div>
                          </td>
                          {isFieldWithInput ? (
                            <td className="cursor-text">
                              {field.secret && !secretRevealed[field.name] ? (
                                <RevealDots
                                  onClick={() => setSecretRevealed({ ...secretRevealed, [field.name]: true })}
                                />
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
                                  value={String(
                                    (field.name in data.config ? data.config[field.name] : field.value) ?? ''
                                  )}
                                  onChange={(value) => updateNodeConfig(id, field.name, value)}
                                  rows={field.rows ?? 3}
                                />
                              ) : field.type === 'boolean' ? (
                                <input
                                  type="checkbox"
                                  checked={
                                    (field.name in data.config ? data.config[field.name] : field.value) == 'true'
                                  }
                                  onChange={(e) =>
                                    updateNodeConfig(id, field.name, e.target.checked ? 'true' : 'false')
                                  }
                                />
                              ) : (
                                <TextInput
                                  theme="node"
                                  placeholder={field.placeholder}
                                  value={String(
                                    (field.name in data.config ? data.config[field.name] : field.value) ?? ''
                                  )}
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
                        </tr>
                      )}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        {output && output.length > 0 && showOutput ? (
          <div className={clsx(titleClassName, 'pb-0.5')}>
            <div className="flex gap-2 items-center">
              {output.map((out, i) => (
                <div className="flex gap-1 items-center" key={i}>
                  <Handle
                    type="source"
                    position={Position.Bottom}
                    id={`fieldOutput`}
                    style={{
                      position: 'relative',
                      transform: 'none',
                      right: 0,
                      top: 0,
                      background: 'black',
                      borderColor: 'white',
                    }}
                    isConnectable={isConnectable}
                    onClick={(e) => {
                      e.stopPropagation()
                      openNewNodePicker(
                        e.clientX, // screenX
                        e.clientY, // screenY
                        (node?.position.x || 0) + Math.random() * 60 - 10, // diagramX
                        (node?.position.y || 0) + (node?.height || 300) + Math.random() * 30 + 20, // diagramY
                        id, // nodeId
                        `fieldOutput`, // handleId
                        'source' // handleType
                      )
                    }}
                  />
                  <CodeArg codeArg={{ type: out.type, name: out.name }} />
                </div>
              ))}
            </div>
            <NodeCache nodeType="app" />
          </div>
        ) : null}
      </div>
    </BindLogic>
  )
}
