import { Node } from '@reactflow/core/dist/esm/types/nodes'
import { Edge } from '@reactflow/core/dist/esm/types/edges'

const SPACE_BETWEEN_NODES = 50
const SPACE_BETWEEN_CHAINS = 50

export function arrangeNodes(nodes: Node[], edges: Edge[]): Node[] {
  let visited = new Set<string>()

  function dfs(currentNodeId: string, chain: Node[]): Node[] {
    visited.add(currentNodeId)

    // Add the current node to the chain
    let currentNode = nodes.find((node) => node.id === currentNodeId)
    if (currentNode) {
      chain.push(currentNode)
    }

    for (let edge of edges) {
      if (edge.source === currentNodeId && !visited.has(edge.target)) {
        dfs(edge.target, chain)
      }
    }

    return chain
  }

  // Step 1: Identify chains
  let chains: Node[][] = []
  let singles: Node[] = []
  for (let node of nodes) {
    if (!visited.has(node.id)) {
      let chain: Node[] = []
      chain = dfs(node.id, chain)

      // Add the chain only if it contains more than one node or doesn't have any incoming or outgoing connections
      if (chain.length > 1) {
        chains.push(chain)
      } else if (!edges.find((e) => e.source === node.id || e.target === node.id)) {
        singles.push(node)
      }
    }
  }

  // Step 2: Position nodes
  const newNodes: Node[] = []
  let currentY = SPACE_BETWEEN_CHAINS
  for (let chain of chains) {
    let currentX = SPACE_BETWEEN_NODES
    for (let node of chain) {
      newNodes.push({ ...node, position: { x: currentX, y: currentY } })
      currentX += (node.width ?? 200) + SPACE_BETWEEN_NODES
    }
    currentY += Math.max(...chain.map((node) => node.height ?? 200)) + SPACE_BETWEEN_CHAINS
  }
  let currentX = SPACE_BETWEEN_NODES
  for (let app of singles) {
    newNodes.push({ ...app, position: { x: currentX, y: currentY } })
    currentX += (app.width ?? 200) + SPACE_BETWEEN_NODES
  }
  return newNodes
}
