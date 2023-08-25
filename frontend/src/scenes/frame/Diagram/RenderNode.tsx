// import 'reactflow/dist/style.css'
import 'reactflow/dist/base.css'
import { useValues } from 'kea'
import { NodeProps, Handle, Position } from 'reactflow'
import { frameLogic } from '../frameLogic'
import clsx from 'clsx'

export function RenderNode({ data, isConnectable }: NodeProps): JSX.Element {
  const { selectedNodeId } = useValues(frameLogic)
  return (
    <div
      className={clsx(
        'p-1 shadow-lg border border-2',
        selectedNodeId === '0'
          ? 'bg-indigo-950 border-indigo-900 shadow-indigo-700/50'
          : 'bg-teal-950 border-teal-900 shadow-teal-700/50'
      )}
    >
      <Handle
        type="target"
        position={Position.Top}
        style={{ marginTop: 3 }}
        onConnect={(params) => console.log('handle onConnect', params)}
        isConnectable={isConnectable}
      />
      <div className="text-xl">{data.label}</div>
    </div>
  )
}
