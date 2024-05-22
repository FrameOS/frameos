import { BaseEdge, EdgeLabelRenderer, EdgeProps, getSmoothStepPath, useReactFlow } from 'reactflow'
import { XCircleIcon } from '@heroicons/react/24/solid'

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
  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={selected ? { strokeWidth: 6, stroke: '#ffffff' } : { strokeWidth: 4, stroke: 'hsl(220 100% 91%)' }}
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
