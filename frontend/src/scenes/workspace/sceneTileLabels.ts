import type { FrameScene } from '../../types'

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

export function sceneTileSummaryLabel(scene: Pick<FrameScene, 'fields' | 'nodes'>): string {
  const nodeCount = scene.nodes?.length ?? 0
  const controlCount = scene.fields?.filter((field) => field.access === 'public').length ?? 0
  const labels = [countLabel(nodeCount, 'node')]

  if (controlCount > 0) {
    labels.push(countLabel(controlCount, 'control'))
  }

  return labels.join(' · ')
}
