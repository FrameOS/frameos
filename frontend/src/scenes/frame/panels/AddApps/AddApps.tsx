import { useActions, useValues } from 'kea'
import { appsModel } from '../../../../models/appsModel'
import { frameLogic } from '../../frameLogic'
import { appsLogic } from '../../appsLogic'
import { Box } from '../../../../components/Box'
import { H6 } from '../../../../components/H6'

export function AddApps() {
  const { apps } = useValues(appsModel)
  const { id } = useValues(frameLogic)
  const { addApp } = useActions(appsLogic({ id }))
  const onDragStart = (event: any, keyword: string) => {
    event.dataTransfer.setData('application/reactflow', keyword)
    event.dataTransfer.effectAllowed = 'move'
  }
  return (
    <div className="space-y-2">
      <div>Drag the boxes below onto the diagram</div>
      {Object.entries(apps).map(([keyword, { name, description }]) => (
        <Box className="bg-gray-900 px-3 py-2 dndnode" draggable onDragStart={(event) => onDragStart(event, keyword)}>
          <H6>{name}</H6>
          <div className="text-sm">{description}</div>
        </Box>
      ))}
    </div>
  )
}
