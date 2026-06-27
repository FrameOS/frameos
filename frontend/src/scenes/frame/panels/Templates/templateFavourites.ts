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

export function templateFavouriteId(template: TemplateType, repository?: RepositoryType): string {
  const templateKey = templateStableKey(template)
  return repository?.url ? `repository:${repository.url}:template:${templateKey}` : `local:${templateKey}`
}
