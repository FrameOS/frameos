import { useActions, useValues } from 'kea'
import { NodeProps, Handle, Position } from 'reactflow'
import clsx from 'clsx'
import { diagramLogic } from './diagramLogic'
import copy from 'copy-to-clipboard'
import { EventNodeData, FrameSceneSettings, StateField } from '../../../../types'
import { stateFieldAccess } from '../../../../utils/fieldTypes'

import { ClipboardIcon, InformationCircleIcon } from '@heroicons/react/24/solid'
import { frameLogic } from '../../frameLogic'
import { DropdownMenu } from '../../../../components/DropdownMenu'
import { ClipboardDocumentIcon, DocumentDuplicateIcon, TrashIcon } from '@heroicons/react/24/solid'
import { appNodeLogic } from './appNodeLogic'
import { newNodePickerLogic } from './newNodePickerLogic'
import { dragHandleProps, pickerHandleProps } from './handleA11y'
import { TextInput } from '../../../../components/TextInput'
import { NumberTextInput } from '../../../../components/NumberTextInput'
import { Select } from '../../../../components/Select'
import { ColorInput } from '../../../../components/ColorInput'
import { FieldTypeTag } from '../../../../components/FieldTypeTag'
import { Tooltip } from '../../../../components/Tooltip'
import { NodeZoomLabel } from './NodeZoomLabel'
import { eventOffersSceneState } from '../../../../utils/eventsContract'
import { frameEventForScene } from '../../../../utils/frameEvents'
import { parseRefreshSeconds, refreshIntervalFieldIndex } from '../../../../utils/refreshInterval'
import { eventFilterControl, eventFilterFieldsToShow, foldedEventFilterCount } from '../../../../utils/eventFilters'

export function EventNode({ id, isConnectable }: NodeProps): JSX.Element {
  const { frameId, sceneId } = useValues(diagramLogic)
  const { width, height, defaultInterval, mode } = useValues(frameLogic)
  const { scene } = useValues(diagramLogic)
  const { selectNode, updateNodeData, copyAppJSON, duplicateNode, deleteApp } = useActions(diagramLogic)
  const { updateScene } = useActions(frameLogic)

  const appNodeLogicProps = { frameId, sceneId, nodeId: id }
  const { node, nodeEdges, isSelected, runtimeNodeError, showMoreEventFilters, frame } = useValues(
    appNodeLogic(appNodeLogicProps)
  )
  const { toggleMoreEventFilters } = useActions(appNodeLogic(appNodeLogicProps))
  const keyword = (node?.data as EventNodeData | undefined)?.keyword ?? ''
  const data = (node?.data as EventNodeData) ?? ({ keyword: '' } satisfies EventNodeData)
  const { openNewNodePicker } = useActions(newNodePickerLogic({ sceneId, frameId }))

  const isEventWithStateFields = eventOffersSceneState(keyword)

  const eventFields = frameEventForScene(keyword, scene)?.fields ?? []
  const fields = isEventWithStateFields ? scene?.fields ?? [] : eventFields
  const eventFilterConfig = { ...(data.config ?? {}) }
  if (keyword === 'button' && eventFilterConfig.label === undefined && 'label' in data) {
    eventFilterConfig.label = data.label
  }

  // A scene that declares its own interval field (by role or by name) keeps
  // its default there; settings.refreshInterval is only the fallback then.
  const refreshFieldIndex = refreshIntervalFieldIndex(scene?.fields)
  const refreshInterval =
    refreshFieldIndex >= 0
      ? parseRefreshSeconds(scene?.fields?.[refreshFieldIndex]?.value) || undefined
      : scene?.settings?.refreshInterval
  const backgroundColor = scene?.settings?.backgroundColor ?? '#000000'

  const updateEventFilter = (fieldName: string, value: string): void => {
    const config = { ...(data.config ?? {}) }
    if (value === '') {
      delete config[fieldName]
    } else {
      config[fieldName] = value
    }
    updateNodeData(id, {
      config,
      ...(keyword === 'button' && fieldName === 'label' ? { label: value } : {}),
    })
  }

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

  const updateRefreshInterval = (value: number | undefined): void => {
    if (!sceneId || refreshFieldIndex < 0) {
      updateSceneSetting('refreshInterval', value)
      return
    }
    updateScene(sceneId, {
      fields: (scene?.fields ?? []).map((field, index) =>
        index === refreshFieldIndex ? { ...field, value: value === undefined ? '' : String(value) } : field
      ),
    })
  }

  // these fields are deprecated, but keep showing nodes that are connected
  const sourceFieldsToShow = fields.filter((field) => {
    const fieldValue = isEventWithStateFields
      ? stateFieldAccess(scene, field, 'state', mode)
      : stateFieldAccess(scene, field, 'context.payload', mode)
    return nodeEdges.some((edge) => edge.sourceHandle === `code/${fieldValue}`)
  })

  const backgroundClassName = clsx(
    'frameos-diagram-node shadow-lg border-2',
    isSelected ? 'frameos-diagram-node-selected' : 'border-red-900 shadow-red-700/50 ',
    runtimeNodeError ? 'border-red-500 shadow-red-500/80 ring-2 ring-red-500/70' : null
  )
  const runtimeErrorTitle = runtimeNodeError ? `${runtimeNodeError.event}: ${runtimeNodeError.message}` : undefined

  const titleBackground = isSelected ? 'frameos-diagram-title-selected' : 'bg-red-900'

  const titleClassName = clsx(
    'frameos-node-title text-xl p-1 px-2 gap-2',
    titleBackground,
    'flex w-full justify-between items-center'
  )
  const eventZoomLabel = <NodeZoomLabel label={keyword} backgroundClassName={titleBackground} />

  const configRows: JSX.Element[] = []

  // Which filters are on screen and what each one draws is utils/eventFilters.ts:
  // the catalog folds the rarely used ones (`filter: "more"`) until set, and a
  // field the contract gives values to is a select, not a text box.
  const filterTitle = 'Leave empty to match any value for this event field.'
  const gpioButtons = frame?.hardware?.gpioButtons
  for (const field of eventFilterFieldsToShow(eventFields, eventFilterConfig, showMoreEventFilters)) {
    const control = eventFilterControl(keyword, field, gpioButtons)
    const value = String(eventFilterConfig[field.name] ?? '')
    configRows.push(
      <tr key={`event-filter-${field.name}`}>
        <td className="font-sm frameos-node-muted-text whitespace-nowrap" title={field.label}>
          {field.label || field.name}
        </td>
        <td>
          {/* A fixed control width: a select would otherwise size the node to its longest option. */}
          <div className="w-44">
            {control.kind === 'select' ? (
              <Select
                theme="node"
                className="nodrag nopan"
                title={filterTitle}
                value={value}
                options={control.options}
                onChange={(next) => updateEventFilter(field.name, next)}
              />
            ) : control.kind === 'number' ? (
              <NumberTextInput
                theme="node"
                title={filterTitle}
                value={value === '' || !Number.isFinite(Number(value)) ? undefined : Number(value)}
                placeholder="any"
                onChange={(next) => updateEventFilter(field.name, next === undefined ? '' : String(next))}
              />
            ) : (
              <TextInput
                theme="node"
                title={filterTitle}
                value={value}
                placeholder="any"
                onChange={(next) => updateEventFilter(field.name, next)}
              />
            )}
          </div>
        </td>
      </tr>
    )
  }
  const foldedFilters = foldedEventFilterCount(eventFields, eventFilterConfig)
  if (foldedFilters > 0 || (showMoreEventFilters && eventFields.some((field) => field.filter === 'more'))) {
    configRows.push(
      <tr key="event-filter-more">
        <td className="w-full" colSpan={2}>
          <button
            type="button"
            className="frameos-node-muted-text text-xs underline nodrag nopan"
            onClick={(e) => {
              e.stopPropagation()
              toggleMoreEventFilters()
            }}
          >
            {showMoreEventFilters ? 'Fewer filters' : `More filters (${foldedFilters})`}
          </button>
        </td>
      </tr>
    )
  }

  if (keyword === 'render') {
    configRows.push(
      <tr key="render-dimensions">
        <td className="font-sm frameos-node-muted-text w-full" colSpan={2}>
          <div className="flex items-center gap-2">
            <div className="flex-1">Dimensions</div>
            <div className="text-white text-sm">{width && height ? `${width}×${height}` : 'Unknown'}</div>
          </div>
        </td>
      </tr>
    )
    configRows.push(
      <tr key="render-refresh">
        <td className="font-sm frameos-node-muted-text w-full" colSpan={2}>
          <div className="flex items-center gap-2">
            <div className="flex-1">Refresh interval</div>
            <Tooltip
              title="The default number of seconds between automatic re-renders of this scene. Can be a large number (3600 seconds = 1 hour), or a very small number for real-time rendering (0.04s = 25fps). Anyone controlling the scene can change it from the scene's options."
              containerClassName="ml-1 inline-block align-sub"
              label="About the render interval"
            >
              <InformationCircleIcon className="frameos-node-muted-text h-4 w-4" aria-hidden="true" />
            </Tooltip>
            <NumberTextInput
              theme="node"
              className="max-w-[70px]"
              value={refreshInterval}
              placeholder={String(defaultInterval)}
              onChange={updateRefreshInterval}
            />
          </div>
        </td>
      </tr>
    )
    configRows.push(
      <tr key="render-background">
        <td className="font-sm frameos-node-muted-text w-full" colSpan={2}>
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
      title={runtimeErrorTitle}
      className={clsx(backgroundClassName, 'relative')}
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
          <Handle
            type="source"
            position={Position.Right}
            id="next"
            {...pickerHandleProps('Next node')}
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
      <div className="relative">
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
                    ? stateFieldAccess(scene, field, 'state', mode)
                    : stateFieldAccess(scene, field, 'context.payload', mode)
                  return (
                    <tr key={i}>
                      <td className="font-sm frameos-node-muted-text w-full" colSpan={3}>
                        <div className="flex items-center gap-2">
                          {field.type ? <FieldTypeTag type={field.type} /> : null}
                          <div className="flex-1" title={field.label}>
                            {field.label ?? field.name}
                          </div>
                          <button
                            type="button"
                            className="shrink-0"
                            title={`Copy ${fieldValue}`}
                            aria-label={`Copy ${fieldValue}`}
                            onClick={() => copy(fieldValue)}
                          >
                            <ClipboardIcon className="w-5 h-5" aria-hidden="true" />
                          </button>
                          <Handle
                            type="source"
                            position={Position.Right}
                            id={`code/${fieldValue}`}
                            {...dragHandleProps(`Output: ${field.label ?? field.name}`)}
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
      {eventZoomLabel}
    </div>
  )
}
