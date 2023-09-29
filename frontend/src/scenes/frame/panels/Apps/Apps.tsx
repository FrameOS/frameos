import { useActions, useValues } from 'kea'
import { appsModel, categoryLabels } from '../../../../models/appsModel'
import { Box } from '../../../../components/Box'
import { H6 } from '../../../../components/H6'
import { PencilSquare } from '../../../../icons/icons'
import { frameLogic } from '../../frameLogic'
import { panelsLogic } from '../panelsLogic'

export function Apps() {
  const { appsByCategory } = useValues(appsModel)
  const { id } = useValues(frameLogic)
  const { editApp } = useActions(panelsLogic({ id }))
  const onDragStart = (event: any, keyword: string) => {
    event.dataTransfer.setData('application/reactflow', JSON.stringify({ type: 'app', keyword }))
    event.dataTransfer.effectAllowed = 'move'
  }
  return (
    <div className="space-y-2">
      <div>Drag the boxes below onto the scene</div>

      {Object.entries(appsByCategory).map(([category, apps]) => (
        <div className="mt-4 space-y-2">
          <H6 className="capitalize mt-4">{categoryLabels[category] ?? category}</H6>
          {Object.entries(apps).map(([keyword, { name, description }]) => (
            <Box
              className="bg-gray-900 px-3 py-2 dndnode cursor-move flex items-center justify-between space-x-2"
              draggable
              onDragStart={(event) => onDragStart(event, keyword)}
            >
              <div>
                <H6>{name}</H6>
                <div className="text-sm">{description}</div>
              </div>
              <div className="cursor-pointer hover:text-blue-400" onClick={() => editApp(keyword)}>
                <PencilSquare />
              </div>
            </Box>
          ))}
        </div>
      ))}
    </div>
  )
}
