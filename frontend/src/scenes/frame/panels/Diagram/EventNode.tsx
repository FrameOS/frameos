import { useActions, useValues } from 'kea'
import { NodeProps, Handle, Position } from 'reactflow'
import clsx from 'clsx'
import { diagramLogic } from './diagramLogic'
import copy from 'copy-to-clipboard'
import { ButtonEventNodeData, EventNodeData, FrameEvent, FrameSceneSettings, StateField } from '../../../../types'
import { stateFieldAccess } from '../../../../utils/fieldTypes'

import _events from '../../../../../schema/events.json'
import { ClipboardIcon, InformationCircleIcon } from '@heroicons/react/24/solid'
import { frameLogic } from '../../frameLogic'
import { DropdownMenu } from '../../../../components/DropdownMenu'
import { ClipboardDocumentIcon, TrashIcon } from '@heroicons/react/24/solid'
import { appNodeLogic } from './appNodeLogic'
import { newNodePickerLogic } from './newNodePickerLogic'
import { TextInput } from '../../../../components/TextInput'
import { NumberTextInput } from '../../../../components/NumberTextInput'
import { ColorInput } from '../../../../components/ColorInput'
import { FieldTypeTag } from '../../../../components/FieldTypeTag'
import { Tooltip } from '../../../../components/Tooltip'

const events: FrameEvent[] = _events as any

export function EventNode({ id, isConnectable }: NodeProps): JSX.Element {
  const { frameId, sceneId } = useValues(diagramLogic)
  const { width, height, defaultInterval } = useValues(frameLogic)
  const { scene } = useValues(diagramLogic)
  const { selectNode, updateNodeData, copyAppJSON, deleteApp } = useActions(diagramLogic)
  const { updateScene } = useActions(frameLogic)

  const appNodeLogicProps = { frameId, sceneId, nodeId: id }
  const { node, nodeEdges, isSelected } = useValues(appNodeLogic(appNodeLogicProps))
  const keyword = (node?.data as EventNodeData | undefined)?.keyword ?? ''
  const data = (node?.data as EventNodeData) ?? ({ keyword: '' } satisfies EventNodeData)
  const { openNewNodePicker } = useActions(newNodePickerLogic({ sceneId, frameId }))

  const isEventWithStateFields = keyword === 'init' || keyword === 'setSceneState' || keyword === 'render'

  const fields = isEventWithStateFields ? scene?.fields ?? [] : events?.find((e) => e.name == keyword)?.fields ?? []

  const refreshInterval = scene?.settings?.refreshInterval
  const backgroundColor = scene?.settings?.backgroundColor ?? '#000000'

  const updateSceneSetting = <K extends keyof FrameSceneSettings>(key: K, value: FrameSceneSettings[K] | undefined) => {
    if (!sceneId) {
      return
    }

    const newSettings: FrameSceneSettings = { ...(scene?.settings ?? {}) }

    if (value === undefined || value === null) {
      delete newSettings[key]
    } else {
      newSettings[key] = value
    }

    updateScene(sceneId, { settings: newSettings })
  }

  // these fields are deprecated, but keep showing nodes that are connected
  const sourceFieldsToShow = fields.filter((field) => {
    const fieldValue = isEventWithStateFields
      ? stateFieldAccess(scene, field, 'state')
      : stateFieldAccess(scene, field, 'context.payload')
    return nodeEdges.some((edge) => edge.sourceHandle === `code/${fieldValue}`)
  })

  const backgroundClassName = clsx(
    'shadow-lg border-2',
    isSelected
      ? 'bg-black bg-opacity-70 border-fuchsia-900 shadow-fuchsia-700/50'
      : 'bg-black bg-opacity-70 border-red-900 shadow-red-700/50 '
  )

  const titleClassName = clsx(
    'frameos-node-title text-xl p-1 px-2 gap-2',
    isSelected ? 'bg-fuchsia-900' : 'bg-red-900',
    'flex w-full justify-between items-center'
  )

  const configRows: JSX.Element[] = []

  if (keyword === 'button') {
    configRows.push(
      <tr key="button-label">
        <td className="font-sm text-indigo-200 w-full">
          <div className="flex items-center gap-2">
            <div className="flex-1">Label</div>
            <TextInput
              value={(data as ButtonEventNodeData).label ?? ''}
              onChange={(value) => updateNodeData(id, { label: value })}
              placeholder="e.g. A"
              theme="node"
            />
          </div>
          <div className="text-xs text-indigo-200 mt-1">Leave empty to match all buttons.</div>
        </td>
      </tr>
    )
  }

  if (keyword === 'render') {
    configRows.push(
      <tr key="render-dimensions">
        <td className="font-sm text-indigo-200 w-full">
          <div className="flex items-center gap-2">
            <div className="flex-1">Dimensions</div>
            <div className="text-white text-sm">{width && height ? `${width}×${height}` : 'Unknown'}</div>
          </div>
        </td>
      </tr>
    )
    configRows.push(
      <tr key="render-refresh">
        <td className="font-sm text-indigo-200 w-full">
          <div className="flex items-center gap-2">
            <div className="flex-1">Refresh interval</div>
            <Tooltip
              title="Seconds between automatic re-renders of this scene. Can be a large number (3600 seconds = 1 hour), or a very small number for real-time rendering (0.04s = 25fps)."
              containerClassName="ml-1 inline-block align-sub"
            >
              <InformationCircleIcon className="w-4 h-4 text-indigo-200" aria-label="Info" />
            </Tooltip>
            <NumberTextInput
              theme="node"
              className="max-w-[70px]"
              value={refreshInterval}
              placeholder={String(defaultInterval)}
              onChange={(value) => updateSceneSetting('refreshInterval', value)}
            />
          </div>
        </td>
      </tr>
    )
    configRows.push(
      <tr key="render-background">
        <td className="font-sm text-indigo-200 w-full">
          <div className="flex items-center gap-2">
            <div className="flex-1">Background color</div>
            <ColorInput
              theme="node"
              className="!min-w-[50px]"
              value={backgroundColor}
              onChange={(value) => updateSceneSetting('backgroundColor', value)}
            />
          </div>
        </td>
      </tr>
    )
  }

  return (
    <div
      onClick={() => {
        if (!isSelected) {
          selectNode(id)
        }
      }}
      className={backgroundClassName}
    >
      <div className={titleClassName}>
        <div>{keyword} (event)</div>
        <div className="flex items-center justify-center gap-2">
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
      {configRows.length > 0 ? (
        <div className="p-1">
          <table className="table-auto border-separate border-spacing-x-1 border-spacing-y-0.5 w-full">
            <tbody>{configRows}</tbody>
          </table>
        </div>
      ) : null}
      {sourceFieldsToShow.length > 0 ? (
        <div className="p-1">
          <table className="table-auto border-separate border-spacing-x-1 border-spacing-y-0.5 w-full">
            <tbody>
              {sourceFieldsToShow.map((field: StateField, i) => {
                const fieldValue = isEventWithStateFields
                  ? stateFieldAccess(scene, field, 'state')
                  : stateFieldAccess(scene, field, 'context.payload')
                return (
                  <tr key={i}>
                    <td className="font-sm text-indigo-200 w-full" colSpan={3}>
                      <div className="flex items-center gap-2">
                        {field.type ? <FieldTypeTag type={field.type} /> : null}
                        <div className="flex-1" title={field.label}>
                          {field.label ?? field.name}
                        </div>
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
                          style={{
                            position: 'relative',
                            transform: 'none',
                            right: 0,
                            top: 0,
                            background: '#000000',
                            borderBottomLeftRadius: 0,
                            borderTopLeftRadius: 0,
                          }}
                          isConnectable={isConnectable}
                        />
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}
