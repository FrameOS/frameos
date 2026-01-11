import { BindLogic, useActions, useValues } from 'kea'
import { NodeProps, Handle, Position, NodeResizer, useUpdateNodeInternals } from 'reactflow'
import { CodeNodeData } from '../../../../types'
import clsx from 'clsx'
import { diagramLogic } from './diagramLogic'
import { TextArea } from '../../../../components/TextArea'
import { DropdownMenu } from '../../../../components/DropdownMenu'
import { CheckIcon, ClipboardDocumentIcon, TrashIcon } from '@heroicons/react/24/solid'
import { appNodeLogic } from './appNodeLogic'
import { NodeCache } from './NodeCache'
import { CodeArg } from './CodeArg'
import { newNodePickerLogic } from './newNodePickerLogic'

export function CodeNode({ id, isConnectable }: NodeProps<CodeNodeData>): JSX.Element {
  const updateNodeInternals = useUpdateNodeInternals()
  const { frameId, sceneId } = useValues(diagramLogic)
  const { updateNodeData, updateEdge, copyAppJSON, deleteApp } = useActions(diagramLogic)
  const appNodeLogicProps = { frameId, sceneId, nodeId: id }
  const { isSelected, node, nodeEdges, codeNodeLanguage } = useValues(appNodeLogic(appNodeLogicProps))
  const data: CodeNodeData = (node?.data as CodeNodeData) ?? ({ code: '' } satisfies CodeNodeData)
  const { select, editCodeField } = useActions(appNodeLogic(appNodeLogicProps))
  const { openNewNodePicker } = useActions(newNodePickerLogic({ sceneId, frameId }))

  return (
    <BindLogic logic={appNodeLogic} props={appNodeLogicProps}>
      <div
        onClick={select}
        className={clsx(
          'shadow-lg border-2 h-full flex flex-col',
          isSelected
            ? 'bg-black bg-opacity-70 border-fuchsia-900 shadow-fuchsia-700/50'
            : 'bg-black bg-opacity-70 border-green-900 shadow-green-700/50 '
        )}
      >
        <NodeResizer minWidth={200} minHeight={119} />
        <div
          className={clsx('flex w-full items-center justify-between', isSelected ? 'bg-fuchsia-900' : 'bg-green-900')}
        >
          <div className={clsx('frameos-node-title text-xl px-1 gap-2', 'flex w-full items-center')}>
            {[...(data.codeArgs ?? []), '+'].map((codeField, i) => (
              <div key={i} className="flex gap-1 items-center">
                <Handle
                  // CodeInputHandle
                  type="target"
                  position={Position.Top}
                  id={`codeField/${typeof codeField === 'object' ? codeField.name : codeField}`}
                  style={{
                    position: 'relative',
                    transform: 'none',
                    left: 0,
                    top: 0,
                    background: 'black',
                    borderColor: 'white',
                  }}
                  isConnectable={isConnectable}
                  onClick={(e) => {
                    e.stopPropagation()
                    const existingNodeCount = nodeEdges.filter(
                      (edge) => edge.targetHandle?.startsWith('codeField/') && edge.target === id
                    ).length
                    openNewNodePicker(
                      e.clientX, // screenX
                      e.clientY, // screenY
                      (node?.position.x || 0) - existingNodeCount * 20, // diagramX
                      (node?.position.y || 0) - 40 - existingNodeCount * 150, // diagramY
                      id, // nodeId
                      `codeField/${typeof codeField === 'object' ? codeField.name : codeField}`, // handleId
                      'target' // handleType
                    )
                  }}
                />
                {codeField === '+' ? (
                  <em
                    onClick={(e) => {
                      e.stopPropagation()
                      const existingNodeCount = nodeEdges.filter(
                        (edge) => edge.targetHandle?.startsWith('codeField/') && edge.target === id
                      ).length
                      openNewNodePicker(
                        e.clientX, // screenX
                        e.clientY, // screenY
                        (node?.position.x || 0) - existingNodeCount * 20, // diagramX
                        (node?.position.y || 0) - 40 - existingNodeCount * 150, // diagramY
                        id, // nodeId
                        `codeField/+`, // handleId
                        'target' // handleType
                      )
                    }}
                  >
                    +
                  </em>
                ) : typeof codeField !== 'string' ? (
                  <div className="cursor-pointer hover:underline">
                    <CodeArg
                      key={`${codeField.type}/${codeField.name}`}
                      codeArg={codeField}
                      onChange={(value) => {
                        updateNodeData(id, {
                          codeArgs: data.codeArgs?.map((c, j) => (i === j ? { ...c, ...value } : c)),
                        })
                        nodeEdges.forEach((edge) => {
                          if (edge.target === id && edge.targetHandle === `codeField/${codeField.name}`) {
                            updateEdge({ ...edge, targetHandle: `codeField/${value.name}` })
                          }
                        })
                        updateNodeInternals(id)
                      }}
                      onDelete={() => editCodeField(codeField.name, '')}
                    />
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          <DropdownMenu
            className="w-fit"
            buttonColor="none"
            horizontal
            items={[
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
              {
                label: `Log output (${data.logOutput ? 'enabled' : 'disabled'})`,
                keepOpen: true,
                onClick: () => updateNodeData(id, { logOutput: !(data.logOutput ?? false) }),
                icon: <CheckIcon className={clsx('w-5 h-5', data.logOutput ? 'opacity-100' : 'opacity-0')} />,
              },
            ]}
          />
        </div>
        <div className="p-1 h-full">
          {codeNodeLanguage === 'js' ? (
            <TextArea
              theme="node"
              className="w-full h-full font-mono resize-none"
              placeholder={data.code ? 'Rewrite to JS: ' + data.code : `e.g: state.magic3 (JavaScript)`}
              value={data.codeJS ?? ''}
              rows={2}
              onChange={(value) => updateNodeData(id, { codeJS: value })}
            />
          ) : (
            <TextArea
              theme="node"
              className="w-full h-full font-mono resize-none"
              placeholder={data.codeJS ? 'Rewrite to Nim: ' + data.codeJS : `e.g: state{"magic3"}.getStr()`}
              value={data.code ?? ''}
              rows={2}
              onChange={(value) => updateNodeData(id, { code: value.replaceAll('\n', '') })}
            />
          )}
        </div>
        <div
          className={clsx(
            'frameos-node-title text-xl px-1 gap-1',
            isSelected ? 'bg-fuchsia-900' : 'bg-green-900',
            'flex w-full justify-between items-center'
          )}
        >
          <div className="flex gap-1 items-center">
            <Handle
              // CodeOutputHandle
              type="source"
              position={Position.Bottom}
              id={`fieldOutput`}
              style={{
                position: 'relative',
                transform: 'none',
                left: 0,
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
            {data.codeOutputs
              ? data.codeOutputs.map((c, i) => (
                  <CodeArg
                    key={`${i}/${c.type}/${c.name}`}
                    codeArg={c}
                    onChange={(value) => {
                      updateNodeData(id, {
                        codeOutputs: data.codeOutputs?.map((c, j) => (i === j ? { ...c, ...value } : c)),
                      })
                    }}
                  />
                ))
              : null}
          </div>
          <div className="flex gap-1 items-center">
            <NodeCache nodeType="code" />
          </div>
        </div>
      </div>
    </BindLogic>
  )
}
