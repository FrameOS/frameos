import { useValues } from 'kea'
import { appsModel } from '../../../../models/appsModel'
import { frameLogic } from '../../frameLogic'
import { Box } from '../../../../components/Box'
import { H6 } from '../../../../components/H6'

export function AddApps() {
  const { apps } = useValues(appsModel)
  const onDragStart = (event: any, type: 'app' | 'event', keyword: string) => {
    event.dataTransfer.setData('application/reactflow', JSON.stringify({ type, keyword }))
    event.dataTransfer.effectAllowed = 'move'
  }
  return (
    <div className="space-y-2">
      <div>Drag the boxes below onto the diagram</div>
      {Object.entries(apps).map(([keyword, { name, description }]) => (
        <Box
          className="bg-gray-900 px-3 py-2 dndnode"
          draggable
          onDragStart={(event) => onDragStart(event, 'app', keyword)}
        >
          <H6>{name}</H6>
          <div className="text-sm">{description}</div>
        </Box>
      ))}

      <H6>Events</H6>
      <Box
        className="bg-gray-900 px-3 py-2 dndnode"
        draggable
        onDragStart={(event) => onDragStart(event, 'event', 'render')}
      >
        <H6>Event: Render</H6>
        <div className="text-sm">When a scene render is requested</div>
      </Box>

      <Box
        className="bg-gray-900 px-3 py-2 dndnode"
        draggable
        onDragStart={(event) => onDragStart(event, 'event', 'button_press')}
      >
        <H6>Event: Button Press</H6>
        <div className="text-sm">When a button is pressed (not implemented yet)</div>
      </Box>
    </div>
  )
}
