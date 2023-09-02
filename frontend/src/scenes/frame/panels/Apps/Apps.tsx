import { useValues } from 'kea'
import { appsModel, categoryLabels } from '../../../../models/appsModel'
import { Box } from '../../../../components/Box'
import { H6 } from '../../../../components/H6'

export function Apps() {
  const { appsByCategory } = useValues(appsModel)
  const onDragStart = (event: any, keyword: string) => {
    event.dataTransfer.setData('application/reactflow', JSON.stringify({ type: 'app', keyword }))
    event.dataTransfer.effectAllowed = 'move'
  }
  return (
    <div className="space-y-2">
      <div>Drag the boxes below onto the diagram</div>

      {Object.entries(appsByCategory).map(([category, apps]) => (
        <div className="mt-4">
          <H6 className="capitalize mt-4 mb-2">{categoryLabels[category] ?? category}</H6>
          {Object.entries(apps).map(([keyword, { name, description }]) => (
            <Box
              className="bg-gray-900 px-3 py-2 dndnode cursor-move"
              draggable
              onDragStart={(event) => onDragStart(event, keyword)}
            >
              <H6>{name}</H6>
              <div className="text-sm">{description}</div>
            </Box>
          ))}
        </div>
      ))}
    </div>
  )
}
