import { Tag } from '../../../../components/Tag'
import { Tooltip } from '../../../../components/Tooltip'
import { nimConverterUrl } from '../../../../utils/sceneExecution'

interface CompiledSceneTagProps {
  className?: string
  /** Frame-level use: how many of the frame's scenes are compiled. */
  count?: number
}

/**
 * The one chip every surface shows for a scene on the legacy compiled path.
 * Amber on purpose: it is a warning, not a badge — the scene needs a full
 * FrameOS source build on every deploy, and the exit is the converter.
 */
export function CompiledSceneTag({ className, count }: CompiledSceneTagProps): JSX.Element {
  const label = count !== undefined ? `⚠ ${count} legacy compiled scene${count === 1 ? '' : 's'}` : '⚠ LEGACY COMPILED'
  return (
    <Tooltip
      containerClassName="inline-block align-middle"
      title={
        <>
          {count !== undefined
            ? `${
                count === 1 ? 'One scene on this frame is' : `${count} scenes on this frame are`
              } a legacy compiled scene — `
            : 'Legacy compiled scene — '}
          needs a whole-frame recompilation on every deploy. Convert it to an interpreted scene at{' '}
          <a href={nimConverterUrl} target="_blank" rel="noreferrer" className="underline">
            scenes.frameos.net/nim-converter
          </a>
          .
        </>
      }
    >
      <Tag className={className} color="orange">
        {label}
      </Tag>
    </Tooltip>
  )
}
