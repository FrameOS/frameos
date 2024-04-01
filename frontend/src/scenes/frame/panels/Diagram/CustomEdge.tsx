import { BaseEdge, EdgeLabelRenderer, EdgeProps, getSimpleBezierPath, Position, useReactFlow } from 'reactflow'
import { XCircleIcon } from '@heroicons/react/24/solid'

export default function CustomEdge({
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
  const isNodeConnection = sourceHandleId === 'next' && targetHandleId === 'prev'
  console.log({
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
    edgePath,
    labelX,
    labelY,
  })

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={
          isNodeConnection
            ? selected
              ? { strokeWidth: 10, stroke: '#ffffff' }
              : { strokeWidth: 8, stroke: 'hsl(202 80% 60% / 1)' }
            : selected
            ? { strokeWidth: 4, stroke: '#ffffff' }
            : { strokeWidth: 2, stroke: '#c5c5c5' }
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
