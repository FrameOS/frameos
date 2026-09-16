import { v4 as uuidv4 } from 'uuid'
import type { DiagramEdge } from '../../../../types'

// The flow of a scene is the chain of `next` → `prev` edges. Deleting a node
// from the middle of that chain used to leave its neighbours dangling; the
// helpers here close the gap: for every chain that enters the deleted set
// and leaves it again, one new next→prev edge joins the surviving ends.

function isFlowEdge(edge: DiagramEdge): boolean {
  return edge.sourceHandle === 'next' || edge.targetHandle === 'prev'
}

/**
 * The next→prev edges that reconnect the chain around `deletedIds`, computed
 * from the edges as they were BEFORE the deletion (the incident ones are the
 * whole point). Deleting a run of consecutive nodes yields one bridge from
 * the node before the run to the node after it; a node with only one flow
 * neighbour needs no bridge; an existing edge between the two ends is not
 * duplicated.
 */
export function bridgeFlowEdges(edgesBefore: DiagramEdge[], deletedIds: ReadonlySet<string>): DiagramEdge[] {
  const nextEdgeBySource = new Map<string, DiagramEdge>()
  for (const edge of edgesBefore) {
    if (isFlowEdge(edge) && !nextEdgeBySource.has(edge.source)) {
      nextEdgeBySource.set(edge.source, edge)
    }
  }
  const bridges: DiagramEdge[] = []
  for (const entering of edgesBefore) {
    if (!isFlowEdge(entering) || !deletedIds.has(entering.target) || deletedIds.has(entering.source)) {
      continue
    }
    // Follow the chain through the deleted nodes until it comes out.
    const visited = new Set<string>()
    let current = entering.target
    let leaving: DiagramEdge | undefined
    while (deletedIds.has(current) && !visited.has(current)) {
      visited.add(current)
      leaving = nextEdgeBySource.get(current)
      if (!leaving) {
        break
      }
      current = leaving.target
    }
    if (!leaving || deletedIds.has(current)) {
      continue
    }
    const alreadyJoined = edgesBefore.some(
      (edge) =>
        isFlowEdge(edge) && edge.source === entering.source && edge.target === current && !deletedIds.has(edge.target)
    )
    if (alreadyJoined || bridges.some((edge) => edge.source === entering.source && edge.target === current)) {
      continue
    }
    bridges.push({
      id: uuidv4(),
      source: entering.source,
      sourceHandle: entering.sourceHandle ?? 'next',
      target: current,
      targetHandle: leaving.targetHandle ?? 'prev',
    })
  }
  return bridges
}

/** The edges after deleting `deletedIds`: the incident ones gone, the chain rejoined. */
export function edgesAfterDeletingNodes(edges: DiagramEdge[], deletedIds: ReadonlySet<string>): DiagramEdge[] {
  const bridges = bridgeFlowEdges(edges, deletedIds)
  const remaining = edges.filter((edge) => !deletedIds.has(edge.source) && !deletedIds.has(edge.target))
  return bridges.length > 0 ? [...remaining, ...bridges] : remaining
}
