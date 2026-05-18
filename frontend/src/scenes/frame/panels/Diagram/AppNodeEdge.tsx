import { BaseEdge, EdgeLabelRenderer, EdgeProps, getSimpleBezierPath, useReactFlow } from 'reactflow'
import { XCircleIcon } from '@heroicons/react/24/solid'

const CONNECTED_TO_SELECTED_NODE_STROKE = '#facc15'

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
  const edgeStyle = isNodeConnection
    ? selected
      ? { strokeWidth: 8, stroke: '#f29cf6' }
      : connectedToSelectedNode
      ? { strokeWidth: 8, stroke: CONNECTED_TO_SELECTED_NODE_STROKE }
      : { strokeWidth: 6, stroke: 'hsl(56 60% 70% / 1)' }
    : selected
    ? { strokeWidth: 4, stroke: '#f29cf6' }
    : connectedToSelectedNode
    ? { strokeWidth: 5, stroke: CONNECTED_TO_SELECTED_NODE_STROKE }
    : { strokeWidth: 2, stroke: '#c5c5c5' }
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
            className="nodrag nopan bg-black rounded-full text-white hover:text-gray-200"
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
