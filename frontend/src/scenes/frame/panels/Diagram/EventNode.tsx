import { useValues } from 'kea'
import { NodeProps, Handle, Position } from 'reactflow'
import { frameLogic } from '../../frameLogic'
import { AppConfig } from '../../../../types'
import clsx from 'clsx'
import { Reveal, RevealDots } from '../../../../components/Reveal'

export function EventNode({ data, id, isConnectable }: NodeProps): JSX.Element {
  const { selectedNodeId } = useValues(frameLogic)
  const { keyword } = data

  return (
    <div
      className={clsx(
        'shadow-lg border border-2',
        selectedNodeId === id
          ? 'bg-black border-indigo-900 shadow-indigo-700/50'
          : 'bg-black border-red-900 shadow-red-700/50 '
      )}
    >
      <div className={clsx('text-xl p-1', selectedNodeId === id ? 'bg-indigo-900' : 'bg-red-900')}>
        Event: {keyword}
      </div>
      <div className="p-1">
        <div className="flex justify-between">
          <div className="flex items-center space-x-1">
            <span>&nbsp;</span>
          </div>
          <div className="flex items-center space-x-1">
            <span>next step</span>
            <Handle
              type="source"
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
