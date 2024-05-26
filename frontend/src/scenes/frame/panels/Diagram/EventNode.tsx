import { useActions, useValues } from 'kea'
import { NodeProps, Handle, Position } from 'reactflow'
import clsx from 'clsx'
import { diagramLogic } from './diagramLogic'
import copy from 'copy-to-clipboard'
import { FrameEvent } from '../../../../types'
import { fieldTypeToGetter } from '../../../../utils/fieldTypes'

import _events from '../../../../../schema/events.json'
import { ClipboardIcon } from '@heroicons/react/24/solid'
import { frameLogic } from '../../frameLogic'
import { Tooltip } from '../../../../components/Tooltip'
import { SceneSettings } from '../Scenes/SceneSettings'
import { EllipsisHorizontalIcon } from '@heroicons/react/24/outline'
import { buttonColor, buttonSize } from '../../../../components/Button'
import { showAsFps } from '../../../../decorators/refreshInterval'

const events: FrameEvent[] = _events as any

export function EventNode(props: NodeProps): JSX.Element {
  const { data, id } = props
  const { frameForm } = useValues(frameLogic)
  const { selectedNodeId, scene } = useValues(diagramLogic)
  const { selectNode } = useActions(diagramLogic)
  const { keyword } = data

  const isEventWithStateFields = keyword === 'init' || keyword === 'setSceneState' || keyword === 'render'

  const fields = isEventWithStateFields ? scene?.fields ?? [] : events?.find((e) => e.name == keyword)?.fields ?? []

  const width = frameForm.rotate === 90 || frameForm.rotate === 270 ? frameForm.height : frameForm.width
  const height = frameForm.rotate === 90 || frameForm.rotate === 270 ? frameForm.width : frameForm.height

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
        <div>{keyword}</div>
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
          />
        </div>
      </div>
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
            <div className="text-2xl mb-1">{`${width}x${height}`}</div>
            {scene?.settings?.refreshInterval ? (
              <div className="text-xl">
                {(scene.settings.refreshInterval >= 1 ? 'refresh: ' : '') + showAsFps(scene.settings.refreshInterval)}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {fields.length > 0 ? (
        <div className="p-1">
          {fields.map((field: Record<string, any>) => (
            <div className="flex items-center justify-end space-x-1 w-full">
              <code className="text-xs mr-2 text-gray-400 flex-1">{field.type}</code>
              <div title={field.label}>{field.name}</div>
              <ClipboardIcon
                className="w-5 h-5 cursor-pointer"
                onClick={() =>
                  copy(
                    isEventWithStateFields
                      ? `state{"${field.name}"}${fieldTypeToGetter[String(field.type ?? 'string')] ?? '.getStr()'}`
                      : `context.payload{"${field.name}"}${
                          fieldTypeToGetter[String(field.type ?? 'string')] ?? '.getStr()'
                        }`
                  )
                }
              />
              <Handle
                type="source"
                position={Position.Right}
                id={
                  isEventWithStateFields
                    ? `code/state{"${field.name}"}${fieldTypeToGetter[String(field.type ?? 'string')] ?? '.getStr()'}`
                    : `code/context.payload{"${field.name}"}${
                        fieldTypeToGetter[String(field.type ?? 'string')] ?? '.getStr()'
                      }`
                }
                style={{ position: 'relative', transform: 'none', right: 0, top: 0, background: '#000000' }}
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
