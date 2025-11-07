import { useActions, useValues } from 'kea'
import { NodeProps, Handle, Position } from 'reactflow'
import clsx from 'clsx'
import { diagramLogic } from './diagramLogic'
import copy from 'copy-to-clipboard'
import { ButtonEventNodeData, EventNodeData, FrameEvent, StateField } from '../../../../types'
import { stateFieldAccess } from '../../../../utils/fieldTypes'

import _events from '../../../../../schema/events.json'
import { ClipboardIcon } from '@heroicons/react/24/solid'
import { frameLogic } from '../../frameLogic'
import { Tooltip } from '../../../../components/Tooltip'
import { SceneSettings } from '../Scenes/SceneSettings'
import { EllipsisHorizontalIcon } from '@heroicons/react/24/outline'
import { buttonColor, buttonSize } from '../../../../components/Button'
import { showAsFps } from '../../../../decorators/refreshInterval'
import { appNodeLogic } from './appNodeLogic'
import { newNodePickerLogic } from './newNodePickerLogic'
import { TextInput } from '../../../../components/TextInput'

const events: FrameEvent[] = _events as any

export function EventNode(props: NodeProps): JSX.Element {
  const { frameId, sceneId } = useValues(diagramLogic)
  const { id } = props
  const { width, height, defaultInterval } = useValues(frameLogic)
  const { selectedNodeId, scene } = useValues(diagramLogic)
  const { selectNode, updateNodeData } = useActions(diagramLogic)

  const appNodeLogicProps = { frameId, sceneId, nodeId: id }
  const { node, nodeEdges } = useValues(appNodeLogic(appNodeLogicProps))
  const keyword = (node?.data as EventNodeData | undefined)?.keyword ?? ''
  const data = (node?.data as EventNodeData) ?? ({ keyword: '' } satisfies EventNodeData)
  const { openNewNodePicker } = useActions(newNodePickerLogic({ sceneId, frameId }))

  const isEventWithStateFields = keyword === 'init' || keyword === 'setSceneState' || keyword === 'render'

  const fields = isEventWithStateFields ? scene?.fields ?? [] : events?.find((e) => e.name == keyword)?.fields ?? []

  // these fields are deprecated, but keep showing nodes that are connected
  const sourceFieldsToShow = fields.filter((field) => {
    const fieldValue = isEventWithStateFields
      ? stateFieldAccess(scene, field, 'state')
      : stateFieldAccess(scene, field, 'context.payload')
    return nodeEdges.some((edge) => edge.sourceHandle === `code/${fieldValue}`)
  })

  return (
    <div
      onClick={() => {
        if (selectedNodeId !== id) {
          selectNode(id)
        }
      }}
      className={clsx(
        'shadow-lg border-2',
        selectedNodeId === id
          ? 'bg-black bg-opacity-70 border-indigo-900 shadow-indigo-700/50'
          : 'bg-black bg-opacity-70 border-red-900 shadow-red-700/50 '
      )}
    >
      <div
        className={clsx(
          'flex gap-2 justify-between items-center frameos-node-title text-xl p-1',
          selectedNodeId === id ? 'bg-indigo-900' : 'bg-red-900'
        )}
      >
        <div>{keyword} (event)</div>
        <div className="flex items-center justify-center gap-2">
          {scene?.id ? (
            <Tooltip
              tooltipColor="gray"
              className={clsx(buttonSize('tiny'), buttonColor('none'))}
              title={<SceneSettings sceneId={scene?.id} />}
            >
              <EllipsisHorizontalIcon className="w-5 h-5" aria-label="Menu" />
            </Tooltip>
          ) : null}
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
            onClick={(e) => {
              e.stopPropagation()
              // NextNodeHandle
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
        </div>
      </div>
      {keyword === 'button' ? (
        <div className="p-1 space-y-1">
          <label className="block text-xs uppercase tracking-wide text-gray-400">Label</label>
          <TextInput
            value={(data as ButtonEventNodeData).label ?? ''}
            onChange={(value) => updateNodeData(id, { label: value })}
            placeholder="e.g. A"
            theme="node"
          />
          <div className="text-xs text-gray-400">Leave empty to listen to all buttons.</div>
        </div>
      ) : null}
      {keyword === 'render' ? (
        // show a blank box with the dimensions of the scene
        <div className="p-1">
          <div
            className="relative flex flex-col items-center justify-center text-center bg-gray-800 text-white border border-gray-700 rounded-md"
            style={{
              aspectRatio: `${width} / ${height}`,
              minWidth: 200,
              maxWidth: 250,
              maxHeight: 250,
              background: scene?.settings?.backgroundColor ?? 'black',
              textShadow: `-1px 0 black, 0 1px black, 1px 0 black, 0 -1px black, 0 0 5px black`,
            }}
          >
            {scene?.nodes?.length === 1 ? <div className="text-md mb-1 p-2">Connect a node to get started.</div> : null}
            {width && height ? <div className="text-2xl mb-1">{`${width}x${height}`}</div> : null}
            <div className="text-xl">
              {((scene?.settings?.refreshInterval ?? defaultInterval) >= 1 ? 'every ' : '') +
                showAsFps(scene?.settings?.refreshInterval ?? defaultInterval)}
            </div>
          </div>
        </div>
      ) : null}
      {sourceFieldsToShow.length > 0 ? (
        <div className="p-1">
          {sourceFieldsToShow.map((field: StateField, i) => {
            const fieldValue = isEventWithStateFields
              ? stateFieldAccess(scene, field, 'state')
              : stateFieldAccess(scene, field, 'context.payload')
            return (
              <div key={i} className="flex items-center justify-end space-x-1 w-full">
                <code className="text-xs mr-2 text-gray-400 flex-1">{field.type}</code>
                <div title={field.label}>{field.name}</div>
                <ClipboardIcon
                  className="w-5 h-5 cursor-pointer"
                  onClick={() =>
                    copy(
                      isEventWithStateFields
                        ? stateFieldAccess(scene, field, 'state')
                        : stateFieldAccess(scene, field, 'context.payload')
                    )
                  }
                />
                <Handle
                  type="source"
                  position={Position.Right}
                  id={`code/${fieldValue}`}
                  style={{ position: 'relative', transform: 'none', right: 0, top: 0, background: '#000000' }}
                />
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
