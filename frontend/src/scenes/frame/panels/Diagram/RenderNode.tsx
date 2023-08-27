import 'reactflow/dist/base.css'
import { useValues } from 'kea'
import { NodeProps, Handle, Position } from 'reactflow'
import { frameLogic } from '../../frameLogic'
import clsx from 'clsx'

export function RenderNode({ data, isConnectable }: NodeProps): JSX.Element {
  const { selectedNodeId } = useValues(frameLogic)
  const id = '0'
  return (
    <div
      className={clsx(
        'shadow-lg border border-2',
        selectedNodeId === id
          ? 'bg-black bg-opacity-70 border-indigo-900 shadow-indigo-700/50'
          : 'bg-black bg-opacity-70 border-green-900 shadow-green-700/50 '
      )}
    >
      <div className={clsx('text-xl p-1', selectedNodeId === id ? 'bg-indigo-900' : 'bg-green-900')}>Render Frame</div>
      <div className="p-1">
        <div className="flex justify-between">
          <div className="flex items-center space-x-1">
            <Handle
              type="target"
              position={Position.Right}
              id="a"
              style={{ position: 'relative', transform: 'none', right: 0, top: 0, background: '#cccccc' }}
              isConnectable={isConnectable}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
