import { BaseEdge, EdgeLabelRenderer, EdgeProps, getSimpleBezierPath, useReactFlow } from 'reactflow'
import { XCircleIcon } from '@heroicons/react/24/solid'
import { useValues } from 'kea'
import { workspaceLogic } from '../../../workspace/workspaceLogic'

const CONNECTED_TO_SELECTED_NODE_STROKE = '#facc15'
const LIGHT_CONNECTED_TO_SELECTED_NODE_STROKE = '#b7791f'

export function AppNodeEdge({
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
  const [edgePath, labelX, labelY] = getSimpleBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })
  const isNodeConnection = sourceHandleId === 'next' || targetHandleId === 'prev'
  const connectedToSelectedNode = Boolean(data?.connectedToSelectedNode)
  const selectedStroke = lightMode ? '#c026d3' : '#f29cf6'
  const connectedStroke = lightMode ? LIGHT_CONNECTED_TO_SELECTED_NODE_STROKE : CONNECTED_TO_SELECTED_NODE_STROKE
  const defaultNodeStroke = lightMode ? '#c7a84d' : 'hsl(56 60% 70% / 1)'
  const defaultFieldStroke = lightMode ? '#94a3b8' : '#c5c5c5'
  const roundedStroke = { strokeLinecap: 'round' as const }
  const edgeStyle = isNodeConnection
    ? selected
      ? { strokeWidth: 8, stroke: selectedStroke, ...roundedStroke }
      : connectedToSelectedNode
      ? { strokeWidth: 8, stroke: connectedStroke, ...roundedStroke }
      : { strokeWidth: 6, stroke: defaultNodeStroke, ...roundedStroke }
    : selected
    ? { strokeWidth: 4, stroke: selectedStroke, ...roundedStroke }
    : connectedToSelectedNode
    ? { strokeWidth: 5, stroke: connectedStroke, ...roundedStroke }
    : { strokeWidth: 2.5, stroke: defaultFieldStroke, ...roundedStroke }
  return (
    <>
      <BaseEdge id={id} path={edgePath} style={edgeStyle} />
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
