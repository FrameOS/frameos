// import 'reactflow/dist/style.css'
import 'reactflow/dist/base.css'
import { useActions, useValues } from 'kea'
import ReactFlow, { Node, NodeProps, Handle, Position, ReactFlowInstance, useStore } from 'reactflow'
import { frameLogic } from './frameLogic'
import { AppConfig } from '../../types'
import { useCallback, useRef, useState } from 'react'
import { appsModel } from '../../models/appsModel'
import { appConfigWithDefaults } from './utils'
import clsx from 'clsx'

function AppNode({ data, id, isConnectable }: NodeProps): JSX.Element {
  const { nodes, selectedNodeId } = useValues(frameLogic)

  const app: AppConfig = data.app
  return (
    <div
      className={clsx(
        'shadow-lg border border-2',
        selectedNodeId === id
          ? 'bg-indigo-950 border-indigo-900 shadow-indigo-700/50'
          : 'bg-sky-950 border-sky-900 shadow-sky-700/50 '
      )}
    >
      <Handle
        type="target"
        position={Position.Top}
        style={{ marginTop: -3 }}
        onConnect={(params) => console.log('handle onConnect', params)}
        isConnectable={isConnectable}
      />
      <div className={clsx('text-xl p-1', selectedNodeId === id ? 'bg-indigo-900' : 'bg-sky-900')}>{app.name}</div>
      {app.config ? (
        <div className="p-1">
          <table className="table-auto border-separate border-spacing-x-1 border-spacing-y-0.5">
            <tbody>
              {Object.entries(app.config).map(([key, value]) => (
                <tr key={key}>
                  <td>{key}</td>
                  <td>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <Handle
        type="source"
        position={Position.Bottom}
        id="a"
        style={{ marginBottom: -3 }}
        isConnectable={isConnectable}
      />
    </div>
  )
}

function OutputNode({ data, isConnectable }: NodeProps): JSX.Element {
  return (
    <div className="bg-Fuchsia-600">
      <Handle
        type="source"
        position={Position.Top}
        style={{ marginTop: 3 }}
        onConnect={(params) => console.log('handle onConnect', params)}
        isConnectable={isConnectable}
      />
      <div className="text-xl">{data.label}</div>
    </div>
  )
}

const nodeTypes = {
  app: AppNode,
  output: OutputNode,
}

export default function RenderLoop() {
  const reactFlowWrapper = useRef<HTMLDivElement>(null)
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null)
  const { nodes, edges } = useValues(frameLogic)
  const { onEdgesChange, onNodesChange, setNodes, addEdge } = useActions(frameLogic)

  const onDragOver = useCallback((event: any) => {
    console.log(event)
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback(
    (event: any) => {
      console.log(event)
      event.preventDefault()

      const reactFlowBounds = reactFlowWrapper.current?.getBoundingClientRect()
      const keyword = event.dataTransfer.getData('application/reactflow')

      // check if the dropped element is valid
      if (typeof keyword === 'undefined' || !keyword) {
        return
      }

      const position = reactFlowInstance?.project({
        x: event.clientX - (reactFlowBounds?.left ?? 0),
        y: event.clientY - (reactFlowBounds?.top ?? 0),
      }) ?? { x: 0, y: 0 }
      const app = appsModel.values.apps[keyword]
      console.log({ apps: appsModel.values.apps, app, keyword })
      const newNode: Node = {
        id: String(Math.random()),
        type: 'app',
        position,
        data: { label: app.name || keyword, app: appConfigWithDefaults(keyword, app) },
      }
      setNodes([...nodes, newNode])
      window.setTimeout(() => reactFlowInstance?.fitView(), 50)
    },
    [reactFlowInstance, nodes]
  )

  return (
    <div className="w-full h-full dndflow" ref={reactFlowWrapper}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onInit={setReactFlowInstance}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={addEdge}
        onDrop={onDrop}
        onDragOver={onDragOver}
        minZoom={0.2}
        maxZoom={4}
        fitView
        fitViewOptions={{ padding: 0.5 }}
        nodeTypes={nodeTypes}
      />
    </div>
  )
}
