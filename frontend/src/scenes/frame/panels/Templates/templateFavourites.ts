import type { RepositoryType, TemplateType } from '../../../../types'
import type { CompatibilityResult } from '../../../../utils/embeddedCompatibility'

export interface TemplateWithFavouriteId {
  compatibility: CompatibilityResult
  favouriteId: string
  repository?: RepositoryType
  template: TemplateType
}

function templateStableKey(template: TemplateType): string {
  return template.id || template.name
}

// The cloud store repository the backend seeds points at the version-filtered
// index (".../api/store/2026.8.3/repository.json", see
// backend/app/api/repositories.py), so its URL moves with every FrameOS
// release. Favourites are persisted by id, so key them on the version-less
// form — otherwise an upgrade would silently drop every favourited store
// scene. The unversioned URL is already this form, so ids stay stable.
function favouriteRepositoryKey(url: string): string {
  return url.replace(/\/api\/store\/[^/]+\/repository\.json$/, '/api/store/repository.json')
}

export function templateFavouriteId(template: TemplateType, repository?: RepositoryType): string {
  const templateKey = templateStableKey(template)
  return repository?.url
    ? `repository:${favouriteRepositoryKey(repository.url)}:template:${templateKey}`
    : `local:${templateKey}`
}
