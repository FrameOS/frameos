import type { StateField } from '../types'

/**
 * The fields of a scene re-applied from its source template, with the values
 * the user set on the installed copy carried over. "Update from repository"
 * used to replace `fields` wholesale, so every default the user had changed
 * (an API key, a city, a refresh interval) reverted to the template's on
 * each update. A field keeps the installed value when the template still has
 * a field of that name and type; new fields, removed fields and fields whose
 * type changed follow the template.
 */
export function mergeInstalledFieldValues(
  installedFields: StateField[] | undefined,
  templateFields: StateField[] | undefined
): StateField[] | undefined {
  if (!templateFields || !installedFields?.length) {
    return templateFields
  }
  const installedByName = new Map<string, StateField>()
  for (const field of installedFields) {
    if (field?.name && !installedByName.has(field.name)) {
      installedByName.set(field.name, field)
    }
  }
  return templateFields.map((field) => {
    const installed = installedByName.get(field.name)
    if (!installed || installed.type !== field.type || installed.value === undefined) {
      return field
    }
    return installed.value === field.value ? field : { ...field, value: installed.value }
  })
}
