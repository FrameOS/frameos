import { BaseEdge, EdgeLabelRenderer, EdgeProps, getSmoothStepPath, useReactFlow } from 'reactflow'
import { XCircleIcon } from '@heroicons/react/24/solid'

const CONNECTED_TO_SELECTED_NODE_STROKE = '#facc15'

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
  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={
          selected
            ? { strokeWidth: 6, stroke: '#f29cf6' }
            : connectedToSelectedNode
            ? { strokeWidth: 6, stroke: CONNECTED_TO_SELECTED_NODE_STROKE }
            : { strokeWidth: 4, stroke: 'hsl(220 100% 91%)' }
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
