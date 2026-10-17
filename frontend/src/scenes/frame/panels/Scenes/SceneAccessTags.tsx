import clsx from 'clsx'
import { Tag } from '../../../../components/Tag'
import { SceneAccessFlag, sceneAccessFlagDescriptions, sceneAccessFlagLabels } from '../../../../utils/sceneAccess'

interface SceneAccessTagsProps {
  /** From sceneAccessFlags / templateAccessFlags (utils/sceneAccess.ts), in display order. */
  flags: SceneAccessFlag[]
  className?: string
  /** Applied to every chip, for tight rows. */
  tagClassName?: string
}

const flagColor: Record<SceneAccessFlag, 'red' | 'orange'> = {
  shell: 'red',
  files: 'red',
  assets: 'orange',
}

/**
 * The chips a scene shows for what it reaches for on the frame: "runs shell
 * commands", "reads all files", "reads assets folder". Read from the scene's
 * own JSON (or the store's flags for a catalog entry), so they say the same
 * thing wherever the scene shows up.
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
          color={flagColor[flag]}
          title={sceneAccessFlagDescriptions[flag]}
          className={clsx('whitespace-nowrap normal-case', tagClassName)}
        >
          {sceneAccessFlagLabels[flag]}
        </Tag>
      ))}
    </span>
  )
}
