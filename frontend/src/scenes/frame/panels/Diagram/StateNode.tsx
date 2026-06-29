import { BindLogic, useActions, useValues } from 'kea'
import { NodeProps, Handle, Position, NodeResizer } from 'reactflow'
import { StateNodeData } from '../../../../types'
import clsx from 'clsx'
import { diagramLogic } from './diagramLogic'
import { appNodeLogic } from './appNodeLogic'
import { newNodePickerLogic } from './newNodePickerLogic'
import { DropdownMenu } from '../../../../components/DropdownMenu'
import { ClipboardDocumentIcon, DocumentDuplicateIcon, TrashIcon } from '@heroicons/react/24/solid'
import { NodeZoomLabel } from './NodeZoomLabel'
import { FieldTypeTag } from '../../../../components/FieldTypeTag'

export function StateNode({ id, isConnectable }: NodeProps<StateNodeData>): JSX.Element {
  const { frameId, sceneId } = useValues(diagramLogic)
  const { copyAppJSON, duplicateNode, deleteApp } = useActions(diagramLogic)
  const appNodeLogicProps = { frameId, sceneId, nodeId: id }
  const { isSelected, node, stateFieldType, stateFieldTitle, runtimeNodeError } = useValues(
    appNodeLogic(appNodeLogicProps)
  )
  const data: StateNodeData = (node?.data as StateNodeData) ?? ({ keyword: '' } satisfies StateNodeData)
  const { select } = useActions(appNodeLogic(appNodeLogicProps))
  const { openNewNodePicker } = useActions(newNodePickerLogic({ sceneId, frameId }))
  const titleBackground = isSelected ? 'frameos-diagram-title-selected' : 'bg-[#7f6e1d]'
  const runtimeErrorTitle = runtimeNodeError ? `${runtimeNodeError.event}: ${runtimeNodeError.message}` : undefined

  return (
    <BindLogic logic={appNodeLogic} props={appNodeLogicProps}>
      <div
        onClick={select}
        title={runtimeErrorTitle}
        className={clsx(
          'frameos-diagram-node shadow-lg border-2 h-full flex flex-col relative',
          isSelected ? 'frameos-diagram-node-selected' : 'border-[#81701d] shadow-[#81701d]/50',
          runtimeNodeError ? 'border-red-500 shadow-red-500/80 ring-2 ring-red-500/70' : null
        )}
      >
        <div className={clsx('frameos-node-title text-xl p-2 gap-2', titleBackground, 'flex w-full items-center')}>
          <Handle
            // StateOutputHandle
            type="source"
            position={Position.Bottom}
            id={`stateOutput`}
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
                `stateOutput`, // handleId
                'source' // handleType
              )
            }}
          />
          <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
            <div className="min-w-0 truncate text-left">{stateFieldTitle ?? data.keyword}</div>
            <FieldTypeTag type={stateFieldType} className="shrink-0" />
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
                label: 'Duplicate',
                onClick: () => duplicateNode(id),
                icon: <DocumentDuplicateIcon className="w-5 h-5" />,
              },
              {
                label: 'Delete Node',
                onClick: () => deleteApp(id),
                icon: <TrashIcon className="w-5 h-5" />,
              },
            ]}
          />
        </div>
        <NodeZoomLabel label={stateFieldTitle ?? data.keyword} backgroundClassName={titleBackground} />
      </div>
    </BindLogic>
  )
}
