import clsx from 'clsx'
import { useValues } from 'kea'
import type { FrameId } from '../../../../types'
import { sceneKeysLogic } from './sceneKeysLogic'
import { Tag } from '../../../../components/Tag'
import { SceneAccessFlag, keyFlagNamespace, sceneAccessTags, type SceneAccessTag } from '../../../../utils/sceneAccess'

interface SceneAccessTagsProps {
  /** From sceneAccessFlags / templateAccessFlags (utils/sceneAccess.ts), in display order. */
  flags: SceneAccessFlag[]
  className?: string
  /** Applied to every chip, for tight rows. */
  tagClassName?: string
  /** An installed scene's key choices, service → what the tag adds ("Work", "not given"): docs/service-keys.md. */
  keyChoices?: Record<string, string>
}

function tagLabel(tag: SceneAccessTag, keyChoices: Record<string, string> | undefined): string {
  const service = tag.flags.length === 1 ? keyFlagNamespace(tag.flags[0]) : null
  const choice = service !== null ? keyChoices?.[service] : undefined
  return choice ? `${tag.label}: ${choice}` : tag.label
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
export function SceneAccessTags({
  flags,
  className,
  tagClassName,
  keyChoices,
}: SceneAccessTagsProps): JSX.Element | null {
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
          {tagLabel(tag, keyChoices)}
        </Tag>
      ))}
    </span>
  )
}

/** An installed scene's tags, each key tag saying which key the install gets ("uses OpenAI key: Work"). */
export function InstalledSceneAccessTags({
  frameId,
  sceneId,
  ...props
}: SceneAccessTagsProps & { frameId: FrameId; sceneId: string }): JSX.Element | null {
  const { keyChoiceLabels } = useValues(sceneKeysLogic({ frameId, sceneId }))
  return <SceneAccessTags {...props} keyChoices={keyChoiceLabels} />
}
