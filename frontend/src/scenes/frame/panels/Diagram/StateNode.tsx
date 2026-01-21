import { BindLogic, useActions, useValues } from 'kea'
import { NodeProps, Handle, Position, NodeResizer } from 'reactflow'
import { StateNodeData } from '../../../../types'
import clsx from 'clsx'
import { diagramLogic } from './diagramLogic'
import { appNodeLogic } from './appNodeLogic'
import { NodeCache } from './NodeCache'
import { CodeArg } from './CodeArg'
import { newNodePickerLogic } from './newNodePickerLogic'

export function StateNode({ id, isConnectable }: NodeProps<StateNodeData>): JSX.Element {
  const { frameId, sceneId } = useValues(diagramLogic)
  const appNodeLogicProps = { frameId, sceneId, nodeId: id }
  const { isSelected, node, stateFieldType, stateFieldTitle } = useValues(appNodeLogic(appNodeLogicProps))
  const data: StateNodeData = (node?.data as StateNodeData) ?? ({ keyword: '' } satisfies StateNodeData)
  const { select } = useActions(appNodeLogic(appNodeLogicProps))
  const { openNewNodePicker } = useActions(newNodePickerLogic({ sceneId, frameId }))

  return (
    <BindLogic logic={appNodeLogic} props={appNodeLogicProps}>
      <div
        onClick={select}
        className={clsx(
          'shadow-lg border-2 h-full flex flex-col',
          isSelected
            ? 'bg-black bg-opacity-70 border-fuchsia-900 shadow-fuchsia-700/50'
            : 'bg-black bg-opacity-70 border-[#81701d] shadow-[#81701d]/50'
        )}
      >
        <div
          className={clsx(
            'frameos-node-title text-xl p-2',
            isSelected ? 'bg-fuchsia-900' : 'bg-[#7f6e1d]',
            'flex w-full justify-between items-center gap-1'
          )}
        >
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
          <CodeArg codeArg={{ name: stateFieldTitle ?? data.keyword, type: stateFieldType }} />
        </div>
      </div>
    </BindLogic>
  )
}
