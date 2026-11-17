import type { FrameId, FrameScene, FrameType, RepositoryType, TemplateType } from '../../types'

// Where a scene of a catalog (the store, a repository, the cloud drive) or
// of this backend's saved scenes is installed already: the install dialog
// greys those frames, and a tile says so before it opens (#871).

export interface InstalledSceneSource {
  template: TemplateType
  /** The catalog the scene comes from; none for a local saved scene. */
  repository: RepositoryType | null
}

/** Whether a frame scene came from this source, by the origin every install
 * stamps: the store scene's id, or the repository and template. */
export function sceneComesFrom(origin: FrameScene['origin'], source: InstalledSceneSource): boolean {
  if (!origin) {
    return false
  }
  if (source.template.sceneId && origin.storeSceneId === source.template.sceneId) {
    return true
  }
  const templateId = source.template.id
  if (!templateId || origin.templateId !== templateId) {
    return false
  }
  return source.repository ? origin.repositoryId === source.repository.id : !origin.repositoryId
}

/** The frames that already have the scene. */
export function framesWithScene(frames: FrameType[], source: InstalledSceneSource): FrameId[] {
  return frames
    .filter((frame) => (frame.scenes ?? []).some((scene) => sceneComesFrom(scene.origin, source)))
    .map((frame) => frame.id)
}
