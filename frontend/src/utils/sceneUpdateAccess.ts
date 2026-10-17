import { type SceneAccessChanges, accessChangesAreRisky, describeGainedAccess } from './sceneAccess'

/**
 * What one update changes in what a scene may do on the frame: the scenes
 * that move together (a multi-scene template, a store scene's pack), named by
 * one of them, and the flag changes between what is installed and the new
 * version's content (utils/sceneAccess.ts).
 */
export interface SceneUpdateAccess {
  /** The installed scenes this update replaces. */
  sceneIds: string[]
  /** How the dialog names them: the installed scene's name. */
  name: string
  changes: SceneAccessChanges
}

export interface SceneUpdateAccessNotice {
  /** Paragraphs for the update dialog ("" when nothing gains a permission). */
  message: string
  /** The scene the dialog is about gains something past the frame's own data. */
  danger: boolean
}

/**
 * The update dialog's word on permissions: one line for the scene it was
 * opened for, and, when it also offers "Update all scenes", one for the
 * others that gain something. Says nothing when nothing is gained.
 */
export function sceneUpdateAccessNotice(
  sceneId: string,
  updates: readonly SceneUpdateAccess[],
  offersUpdateAll: boolean
): SceneUpdateAccessNotice {
  const own = updates.find((update) => update.sceneIds.includes(sceneId))
  const paragraphs: string[] = []
  const ownGain = own ? describeGainedAccess(own.changes) : ''
  if (ownGain) {
    paragraphs.push(`New permissions in this version: ${ownGain}.`)
  }
  if (offersUpdateAll) {
    const others = updates
      .filter((update) => update !== own)
      .map((update) => ({ name: update.name, gain: describeGainedAccess(update.changes) }))
      .filter((update) => update.gain)
    if (others.length > 0) {
      paragraphs.push(
        `Updating all scenes also adds new permissions: ${others
          .map((update) => `"${update.name}" ${update.gain}`)
          .join('; ')}.`
      )
    }
  }
  return { message: paragraphs.join('\n\n'), danger: own ? accessChangesAreRisky(own.changes) : false }
}
