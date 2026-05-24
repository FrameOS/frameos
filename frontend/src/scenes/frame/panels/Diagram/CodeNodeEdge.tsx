import { BaseEdge, EdgeLabelRenderer, EdgeProps, getSmoothStepPath, useReactFlow } from 'reactflow'
import { XCircleIcon } from '@heroicons/react/24/solid'
import { useValues } from 'kea'
import { workspaceLogic } from '../../../workspace/workspaceLogic'

const CONNECTED_TO_SELECTED_NODE_STROKE = '#facc15'
const LIGHT_CONNECTED_TO_SELECTED_NODE_STROKE = '#b7791f'

export function CodeNodeEdge({
  id,
  sourcePosition,
  sourceX,
  sourceY,
  targetPosition,
  targetX,
  targetY,
  sourceHandleId,
  targetHandleId,
  selected,
  data,
}: EdgeProps) {
  const { setEdges } = useReactFlow()
  const { theme } = useValues(workspaceLogic)
  const lightMode = theme !== 'dark'
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })
  const isNodeConnection = sourceHandleId === 'next' && targetHandleId === 'prev'
  const connectedToSelectedNode = Boolean(data?.connectedToSelectedNode)
  const selectedStroke = lightMode ? '#c026d3' : '#f29cf6'
  const connectedStroke = lightMode ? LIGHT_CONNECTED_TO_SELECTED_NODE_STROKE : CONNECTED_TO_SELECTED_NODE_STROKE
  const defaultStroke = lightMode ? '#8aa4ce' : 'hsl(220 100% 91%)'
  const roundedStroke = { strokeLinecap: 'round' as const }
  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={
          selected
            ? { strokeWidth: 6, stroke: selectedStroke, ...roundedStroke }
            : connectedToSelectedNode
            ? { strokeWidth: 6, stroke: connectedStroke, ...roundedStroke }
            : { strokeWidth: 4, stroke: defaultStroke, ...roundedStroke }
        }
      />
      <EdgeLabelRenderer>
        {selected ? (
          <button
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: 'all',
            }}
            className="frameos-secondary-button nodrag nopan rounded-lg"
            onClick={() => {
              setEdges((es) => es.filter((e) => e.id !== id))
            }}
          >
            <XCircleIcon className={isNodeConnection ? 'h-8 w-8' : 'h-5 w-5'} />
          </button>
        ) : null}
      </EdgeLabelRenderer>
    </>
  )
}
