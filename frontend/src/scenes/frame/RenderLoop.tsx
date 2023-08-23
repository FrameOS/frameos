import React from 'react'
import ReactFlow, { Edge, Node } from 'reactflow'

import 'reactflow/dist/style.css'

const initialNodes: Node[] = [
  { id: '1', position: { x: 0, y: 0 }, data: { label: '1. Fetch Random Unsplash: nature' } },
  { id: '2', position: { x: 0, y: 100 }, data: { label: '2. Add calendar' } },
  { id: '3', position: { x: 0, y: 200 }, data: { label: '3. Render frame' } },
]
const initialEdges: Edge[] = [
  { id: 'e1-2', source: '1', target: '2' },
  { id: 'e2-3', source: '2', target: '3' },
]

export default function RenderLoop() {
  return (
    <div className="w-full h-full">
      <ReactFlow nodes={initialNodes} edges={initialEdges} fitView />
    </div>
  )
}
