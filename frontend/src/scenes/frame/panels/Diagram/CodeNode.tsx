import { useActions, useValues } from 'kea'
import { NodeProps, Handle, Position } from 'reactflow'
import { CodeNodeData } from '../../../../types'
import clsx from 'clsx'
import { diagramLogic } from './diagramLogic'
import React from 'react'
import { TextArea } from '../../../../components/TextArea'
import { DropdownMenu } from '../../../../components/DropdownMenu'
import { ClipboardDocumentIcon, TrashIcon } from '@heroicons/react/24/solid'
import { appNodeLogic } from './appNodeLogic'

export function CodeNode({ data, id, isConnectable }: NodeProps<CodeNodeData>): JSX.Element {
  const { frameId, sceneId } = useValues(diagramLogic)
  const { updateNodeData, copyAppJSON, deleteApp } = useActions(diagramLogic)
  const appNodeLogicProps = { frameId, sceneId, nodeId: id }
  const { isSelected, nodeEdges } = useValues(appNodeLogic(appNodeLogicProps))

  const targetNode = nodeEdges.find(
    (edge) => edge.sourceHandle === 'next' && edge.targetHandle.startsWith('fieldInput/')
  )
  const targetFunction = targetNode?.targetHandle.replace('fieldInput/', '')

  return (
    <div
      className={clsx(
        'shadow-lg border border-2',
        isSelected
          ? 'bg-black bg-opacity-70 border-indigo-900 shadow-indigo-700/50'
          : 'bg-black bg-opacity-70 border-sky-900 shadow-sky-700/50 '
      )}
    >
      <div
        className={clsx(
          'text-xl p-1 gap-1',
          isSelected ? 'bg-indigo-900' : 'bg-sky-900',
          'flex w-full justify-between items-center'
        )}
      >
        <div>{targetFunction ?? 'Custom code'}</div>
        <DropdownMenu
          className="w-fit"
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
          ]}
        />
      </div>
      <div className="p-1">
        <table className="table-auto border-separate border-spacing-x-1 border-spacing-y-0.5">
          <tbody>
            <tr>
              <td className="cursor-text">
                <TextArea
                  theme="node"
                  placeholder="Inlined nim code"
                  value={data.code ?? ''}
                  onChange={(value) => updateNodeData(id, { code: value })}
                  rows={3}
                />
              </td>
              <td>
                <Handle
                  type="source"
                  position={Position.Right}
                  id={`next`}
                  style={{
                    position: 'relative',
                    transform: 'none',
                    right: 0,
                    top: 0,
                    background: '#cccccc',
                  }}
                  isConnectable={isConnectable}
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}
