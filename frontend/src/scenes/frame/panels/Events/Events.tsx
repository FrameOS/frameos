import { Box } from '../../../../components/Box'
import { H6 } from '../../../../components/H6'

const events = {
  init: 'Scene initialization. Triggered when the scene is loaded.',
  render: "Render the scene. Triggered according to the frame's refresh interval, or when explicitly requested.",
  keyboard: 'When a key is pressed or released on a keyboard',
  mouse: 'When a mouse moves or a touchscreen is clicked',
}

export function Events() {
  const onDragStart = (event: any, type: 'event', keyword: string) => {
    event.dataTransfer.setData('application/reactflow', JSON.stringify({ type, keyword }))
    event.dataTransfer.effectAllowed = 'move'
  }
  return (
    <div className="space-y-2">
      <div>Did you know: the "render" event can be dispatched or listened to. Connect either end.</div>

      {Object.entries(events).map(([keyword, description]) => (
        <Box
          className="bg-gray-900 px-3 py-2 dndnode flex items-center justify-between space-x-2 cursor-move"
          draggable
          onDragStart={(event) => onDragStart(event, 'event', keyword)}
        >
          <div>
            <H6>Event: {keyword}</H6>
            <div className="text-sm">{description}</div>
          </div>
        </Box>
      ))}
    </div>
  )
}
