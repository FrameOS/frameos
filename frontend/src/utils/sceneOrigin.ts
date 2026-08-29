import { FrameScene, RepositoryType, SceneOrigin, TemplateType } from '../types'

export function sceneOriginForTemplate(
  repository: RepositoryType,
  template: Partial<TemplateType>,
  templateSceneId: string
): SceneOrigin {
  return {
    // Store-backed repositories (the FrameOS Cloud store, "my cloud scenes")
    // name the scene's page and uuid in the index; plain repositories don't.
    ...(template.url ? { href: template.url } : {}),
    ...(template.sceneId ? { storeSceneId: template.sceneId } : {}),
    ...(repository.id ? { repositoryId: repository.id } : {}),
    repositoryUrl: repository.url,
    ...(template.id ? { templateId: template.id } : {}),
    ...(template.name ? { templateName: template.name } : {}),
    sceneId: templateSceneId,
    ...(template.version ? { version: template.version } : {}),
  }
}

/** Stamp each scene of a loaded template with its origin, so installed copies can be updated later. */
export function templateWithSceneOrigins(
  template: Partial<TemplateType>,
  repository: RepositoryType
): Partial<TemplateType> {
  return {
    ...template,
    scenes: (template.scenes ?? []).map((scene) => ({
      ...scene,
      origin: sceneOriginForTemplate(repository, template, scene.id),
    })),
  }
}

/** Do two origins point at the same template (ignoring version and scene)? */
export function sameTemplateOrigin(a?: SceneOrigin, b?: SceneOrigin): boolean {
  if (!a || !b) {
    return false
  }
  // A store scene is the same scene whichever repository index listed it.
  if (a.storeSceneId && b.storeSceneId) {
    return a.storeSceneId === b.storeSceneId
  }
  const repositoryMatch =
    a.repositoryId && b.repositoryId
      ? a.repositoryId === b.repositoryId
      : !!a.repositoryUrl && a.repositoryUrl === b.repositoryUrl
  if (!repositoryMatch) {
    return false
  }
  return a.templateId && b.templateId
    ? a.templateId === b.templateId
    : !!a.templateName && a.templateName === b.templateName
}

export interface OriginTemplateMatch {
  repository: RepositoryType
  template: TemplateType
}

export function findTemplateForOrigin(
  repositories: RepositoryType[],
  origin: SceneOrigin | undefined
): OriginTemplateMatch | null {
  if (!origin) {
    return null
  }
  // A store scene (a zip downloaded from scenes.frameos.net, a cloud-pushed
  // scene) is matched by its uuid in whichever repository index lists it.
  if (origin.storeSceneId) {
    for (const repository of repositories) {
      const template = (repository.templates ?? []).find((candidate) => candidate.sceneId === origin.storeSceneId)
      if (template) {
        return { repository, template }
      }
    }
  }
  for (const repository of repositories) {
    const repositoryMatch =
      (origin.repositoryId && repository.id === origin.repositoryId) ||
      (origin.repositoryUrl && repository.url === origin.repositoryUrl)
    if (!repositoryMatch) {
      continue
    }
    for (const template of repository.templates ?? []) {
      if (
        origin.templateId && template.id
          ? template.id === origin.templateId
          : !!origin.templateName && template.name === origin.templateName
      ) {
        return { repository, template }
      }
    }
  }
  return null
}

/** The new version if the scene's source template has changed since install, else null. */
export function sceneUpdateVersion(scene: FrameScene, repositories: RepositoryType[]): string | null {
  const origin = scene.origin
  if (!origin?.version) {
    return null
  }
  const match = findTemplateForOrigin(repositories, origin)
  if (!match?.template.version || match.template.version === origin.version) {
    return null
  }
  return match.template.version
}

/** Content hashes are long; keep displayed versions short. */
export function shortSceneVersion(version: string): string {
  return version.length > 8 ? version.slice(0, 8) : version
}
