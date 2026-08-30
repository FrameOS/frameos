import { Tag } from '../../../../components/Tag'
import { Tooltip } from '../../../../components/Tooltip'
import { nimConverterUrl } from '../../../../utils/sceneExecution'

interface CompiledSceneTagProps {
  className?: string
  /** Frame-level use: how many of the frame's scenes are compiled. */
  count?: number
  /**
   * Whether the frame's legacy source-build door is open (`frameLegacySourceBuild`).
   * Shut, the scene does not run at all on the release binary; open, it costs a
   * whole-frame source build on every deploy.
   */
  legacySourceBuild?: boolean
}

/**
 * The one chip every surface shows for a scene on the legacy compiled path.
 * Amber on purpose: it is a warning, not a badge — the scene needs a full
 * FrameOS source build on every deploy, and the exit is the converter.
 */
export function CompiledSceneTag({ className, count, legacySourceBuild }: CompiledSceneTagProps): JSX.Element {
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
          {legacySourceBuild
            ? 'needs a whole-frame source build on every deploy (the legacy source build is on for this frame). '
            : 'does not run on the released FrameOS binary this frame installs. '}
          Convert it to an interpreted scene at{' '}
          <a href={nimConverterUrl} target="_blank" rel="noreferrer" className="underline">
            scenes.frameos.net/nim-converter
          </a>
          {legacySourceBuild ? '.' : ", or turn on the legacy source build in the frame's advanced settings."}
        </>
      }
    >
      <Tag className={className} color="orange">
        {label}
      </Tag>
    </Tooltip>
  )
}
