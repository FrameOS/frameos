import { Tag } from '../../../../components/Tag'
import { Tooltip } from '../../../../components/Tooltip'
import { nimConverterUrl } from '../../../../utils/sceneExecution'

interface CompiledSceneTagProps {
  className?: string
  /** Frame-level use: how many of the frame's scenes are compiled. */
  count?: number
  /**
   * Wired where one scene is in view: converts it and keeps the result as a
   * copy, leaving the legacy scene alone. Omitted (frame cards, counts) the
   * tooltip just points at the hosted converter.
   */
  onConvertCopy?: () => void
  converting?: boolean
}

/**
 * The one chip every surface shows for a scene on the legacy compiled path.
 * Amber on purpose: it is a warning, not a badge — the scene needs a full
 * FrameOS source build on every deploy, and the exit is the converter.
 */
export function CompiledSceneTag({ className, count, onConvertCopy, converting }: CompiledSceneTagProps): JSX.Element {
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
          needs a whole-frame recompilation on every deploy.
          {onConvertCopy ? (
            <>
              <button
                type="button"
                disabled={converting}
                onClick={onConvertCopy}
                className="mt-2 mb-1 block w-full rounded bg-amber-950 px-2 py-1 text-xs font-semibold text-amber-50 hover:bg-amber-800 disabled:opacity-60"
              >
                {converting ? 'Converting…' : 'Convert to an interpreted copy'}
              </button>
              Ports the scene's Nim to JavaScript and saves that as a new scene — this one is left exactly as it is. Or
              convert it by hand at{' '}
            </>
          ) : (
            <> Convert it to an interpreted scene at </>
          )}
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
