import clsx from 'clsx'
import { Tag } from '../../../../components/Tag'
import {
  SceneAccessFlag,
  sceneAccessFlagDescription,
  sceneAccessFlagIsRisky,
  sceneAccessFlagLabel,
} from '../../../../utils/sceneAccess'

interface SceneAccessTagsProps {
  /** From sceneAccessFlags / templateAccessFlags (utils/sceneAccess.ts), in display order. */
  flags: SceneAccessFlag[]
  className?: string
  /** Applied to every chip, for tight rows. */
  tagClassName?: string
}

// Red for what reaches past the scene's own reading of your photos (shell
// commands, any file on the frame, writing or deleting in the assets folder),
// orange for reading the assets folder, gray for the API keys its apps read.
function flagColor(flag: SceneAccessFlag): 'red' | 'orange' | 'gray' {
  return sceneAccessFlagIsRisky(flag) ? 'red' : flag === 'assets' ? 'orange' : 'gray'
}

/**
 * The chips a scene shows for what its apps ask for on the frame: "runs shell
 * commands", "reads all files", "reads assets folder", "writes assets
 * folder", "uses OpenAI key". Read from the scene's own JSON (or the store's
 * flags for a catalog entry), so they say the same thing wherever the scene
 * shows up.
 */
export function SceneAccessTags({ flags, className, tagClassName }: SceneAccessTagsProps): JSX.Element | null {
  if (flags.length === 0) {
    return null
  }
  return (
    <span className={clsx('inline-flex flex-wrap items-center gap-1', className)}>
      {flags.map((flag) => (
        <Tag
          key={flag}
          color={flagColor(flag)}
          title={sceneAccessFlagDescription(flag)}
          className={clsx('whitespace-nowrap normal-case', tagClassName)}
        >
          {sceneAccessFlagLabel(flag)}
        </Tag>
      ))}
    </span>
  )
}
