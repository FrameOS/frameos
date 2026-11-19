import clsx from 'clsx'
import { Tag } from '../../../../components/Tag'
import { SceneAccessFlag, sceneAccessTags, type SceneAccessTag } from '../../../../utils/sceneAccess'

interface SceneAccessTagsProps {
  /** From sceneAccessFlags / templateAccessFlags (utils/sceneAccess.ts), in display order. */
  flags: SceneAccessFlag[]
  className?: string
  /** Applied to every chip, for tight rows. */
  tagClassName?: string
}

// Red for what reaches past the scene's own reading of your photos (shell
// commands, any file on the frame, writing or deleting files), orange for
// reading files, gray for the API keys its apps read. The theme's tag colors,
// light and dark.
function tagColor(tag: SceneAccessTag): 'red' | 'orange' | 'gray' {
  return tag.risky ? 'red' : tag.flags.includes('assets') ? 'orange' : 'gray'
}

/**
 * The chips a scene shows for what its apps ask for on the frame: "runs shell
 * commands", "reads all files", "reads files", "writes files", "reads &
 * writes files", "uses OpenAI key" (`sceneAccessTags`). Read from the scene's
 * own JSON (or the store's flags for a catalog entry), so they say the same
 * thing wherever the scene shows up.
 */
export function SceneAccessTags({ flags, className, tagClassName }: SceneAccessTagsProps): JSX.Element | null {
  if (flags.length === 0) {
    return null
  }
  return (
    <span className={clsx('inline-flex flex-wrap items-center gap-1', className)}>
      {sceneAccessTags(flags).map((tag) => (
        <Tag
          key={tag.key}
          color={tagColor(tag)}
          title={tag.description}
          className={clsx('whitespace-nowrap normal-case', tagClassName)}
        >
          {tag.label}
        </Tag>
      ))}
    </span>
  )
}
