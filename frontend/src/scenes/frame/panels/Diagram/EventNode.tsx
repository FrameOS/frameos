import { useValues } from 'kea'
import { NodeProps, Handle, Position } from 'reactflow'
import clsx from 'clsx'
import { diagramLogic } from './diagramLogic'

import { FrameEvent } from '../../../../types'
import { fieldTypeToGetter } from '../../../../utils/fieldTypes'

import _events from '../Events/events.json'
const events: Record<string, FrameEvent> = _events as any

export function EventNode(props: NodeProps): JSX.Element {
  const { data, id } = props
  const { selectedNodeId, scene } = useValues(diagramLogic)
  const { keyword } = data

  const fields =
    keyword === 'init' || keyword === 'setSceneState' ? scene?.fields ?? [] : events?.[keyword]?.fields ?? []

  return (
    <div
      className={clsx(
        'shadow-lg border border-2',
        selectedNodeId === id
          ? 'bg-black bg-opacity-70 border-indigo-900 shadow-indigo-700/50'
          : 'bg-black bg-opacity-70 border-red-900 shadow-red-700/50 '
      )}
    >
      <div className={clsx('frameos-node-title text-xl p-1', selectedNodeId === id ? 'bg-indigo-900' : 'bg-red-900')}>
        {keyword}
      </div>
      <div className="p-1">
        <div className="flex justify-between">
          <div className="flex items-center space-x-1">
            <span>&nbsp;</span>
          </div>
          <div className="flex items-center space-x-1">
            <Handle
              type="source"
              position={Position.Right}
              id="next"
              style={{ position: 'relative', transform: 'none', right: 0, top: 0, background: '#cccccc' }}
            />
          </div>
        </div>
        {fields.map((field: Record<string, any>) => (
          <div className="flex items-center justify-end space-x-1 w-full">
            <code className="text-xs mr-2 text-gray-400 flex-1">{field.type}</code>
            <div title={field.label}>{field.name}</div>
            <Handle
              type="source"
              position={Position.Right}
              id={`code/context.payload{"${field.name}"}${
                fieldTypeToGetter[String(field.type ?? 'string')] ?? '.getStr()'
              }`}
              style={{ position: 'relative', transform: 'none', right: 0, top: 0, background: '#000000' }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
