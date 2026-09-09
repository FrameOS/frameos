import { builtinFrameEventNames } from '../../utils/frameEvents'
import { FrameScene } from '../../types'

// The per-scene slice of frameForm validation (state fields + custom events),
// shared by the real frameLogic form and the embedded editor's in-memory shim
// so both editors flag the same problems.
export function frameFormSceneErrors(scenes: Partial<FrameScene>[] | undefined): Record<string, any>[] {
  return (scenes ?? []).map((scene: Record<string, any>) => {
    const customEventNames = (scene.customEvents ?? []).map((event: Record<string, any>) =>
      String(event.name ?? '').trim()
    )
    // Two fields named `city` deployed fine, the second silently won on the
    // device, and the Control panel rendered two identical inputs writing one
    // key — custom events had the uniqueness check, state fields did not.
    const fieldNames = (scene.fields ?? []).map((field: Record<string, any>) => String(field.name ?? '').trim())
    return {
      fields: (scene.fields ?? []).map((field: Record<string, any>, fieldIndex: number) => {
        const name = String(field.name ?? '').trim()
        return {
          name: !name
            ? 'Codename is required'
            : fieldNames.findIndex((candidate: string) => candidate === name) !== fieldIndex
            ? 'Codename must be unique'
            : '',
          type: field.type ? '' : 'Type is required',
        }
      }),
      customEvents: (scene.customEvents ?? []).map((event: Record<string, any>, eventIndex: number) => {
        const name = String(event.name ?? '').trim()
        return {
          name: !name
            ? 'Event name is required'
            : builtinFrameEventNames.has(name)
            ? 'Event name must not match a built-in event'
            : customEventNames.findIndex((candidate: string) => candidate === name) !== eventIndex
            ? 'Event name must be unique'
            : '',
          fields: (event.fields ?? []).map((field: Record<string, any>) => ({
            name: String(field.name ?? '').trim() ? '' : 'Codename is required',
            type: field.type ? '' : 'Type is required',
          })),
        }
      }),
    }
  })
}
