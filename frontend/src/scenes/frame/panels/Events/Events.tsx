import { Box } from '../../../../components/Box'
import { H6 } from '../../../../components/H6'
import { FrameEvent } from '../../../../types'

import _events from './events.json'
const events: Record<string, FrameEvent> = _events as any

export function Events() {
  const onDragStart = (event: any, type: 'event', keyword: string) => {
    event.dataTransfer.setData('application/reactflow', JSON.stringify({ type, keyword }))
    event.dataTransfer.effectAllowed = 'move'
  }
  return (
    <div className="space-y-2">
      <div>Did you know: the "render" event can be dispatched or listened to. Connect either end.</div>

      {Object.values(events).map(({ name, description, fields }) => (
        <Box
          className="bg-gray-900 px-3 py-2 dndnode flex items-center justify-between space-x-2 cursor-move"
          draggable
          onDragStart={(event) => onDragStart(event, 'event', name)}
        >
          <div>
            <H6>Event: {name}</H6>
            <div className="text-sm">
              {description}
              {fields && fields.length > 0 ? ' (' + fields.map((f) => `${f.name}: ${f.type}`).join(', ') + ')' : ''}
            </div>
          </div>
        </Box>
      ))}
    </div>
  )
}
