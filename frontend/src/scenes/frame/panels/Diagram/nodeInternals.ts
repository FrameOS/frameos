// reactflow measures a node's handles when the node mounts and when its size
// changes. A handle added to a node that already exists (a new code argument,
// an app whose config.json gained a field) is only measured once someone
// calls updateNodeInternals — until then an edge into it has no anchor and
// is drawn against stale bounds or not at all.
//
// The editor used to call it on a fixed 200 ms timer after every insertion,
// which left a 200 ms window of wrong edges and still raced a slow commit.
// The nodes whose handles change now re-measure themselves in an effect
// (CodeNode, AppNode: runs after the commit that rendered the new handle);
// this is the belt-and-braces call for the logic that created the change,
// run on the frame after React has committed it instead of a guessed delay.

export function refreshNodeInternals(update: ((nodeId: string) => void) | undefined, nodeIds: string[]): void {
  if (!update || nodeIds.length === 0) {
    return
  }
  const run = (): void => nodeIds.forEach((nodeId) => update(nodeId))
  if (typeof requestAnimationFrame === 'function') {
    // Two frames: the first runs before React's commit may have painted.
    requestAnimationFrame(() => requestAnimationFrame(run))
  } else {
    setTimeout(run, 0)
  }
}
