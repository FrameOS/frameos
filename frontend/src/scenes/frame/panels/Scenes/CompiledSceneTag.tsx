import { useActions, useValues } from 'kea'
import { Tag } from '../../../../components/Tag'
import { Tooltip } from '../../../../components/Tooltip'
import { nimConverterUrl } from '../../../../utils/sceneExecution'
import { frameLogic } from '../../frameLogic'
import type { FrameId } from '../../../../types'

interface CompiledSceneTagProps {
  className?: string
  /** Frame-level use: how many of the frame's scenes are compiled. */
  count?: number
  /**
   * Given both, the tooltip offers the one-click conversion of that scene.
   * Frame-level tags (a count, a card that stands for the whole frame) leave
   * them out and the tooltip just points at the hosted converter.
   */
  frameId?: FrameId
  sceneId?: string
  /** Chip text, for tight rows that cannot spare the full warning. */
  label?: string
}

/**
 * The conversion the tag offers: the same in-place, unsaved conversion the
 * diagram's Nim nodes offer (frameLogic). Its own component so the hooks only
 * run where a scene is actually in view.
 */
function ConvertSceneButton({ frameId, sceneId }: { frameId: FrameId; sceneId: string }): JSX.Element {
  const { convertingSceneId } = useValues(frameLogic({ frameId }))
  const { convertSceneToInterpreted } = useActions(frameLogic({ frameId }))
  const converting = convertingSceneId === sceneId
  return (
    <button
      type="button"
      disabled={converting}
      onClick={(event) => {
        event.stopPropagation()
        convertSceneToInterpreted(sceneId)
      }}
      className="mt-2 mb-1 block w-full rounded bg-amber-950 px-2 py-1 text-xs font-semibold text-amber-50 hover:bg-amber-800 disabled:opacity-60"
    >
      {converting ? 'Converting…' : 'Convert this scene'}
    </button>
  )
}

/**
 * The one chip every surface shows for a scene on the legacy compiled path.
 * Amber on purpose: it is a warning, not a badge — the scene needs a full
 * FrameOS source build on every deploy, and the exit is the converter.
 */
export function CompiledSceneTag({ className, count, frameId, sceneId, label }: CompiledSceneTagProps): JSX.Element {
  const chipLabel =
    label ?? (count !== undefined ? `⚠ ${count} legacy compiled scene${count === 1 ? '' : 's'}` : '⚠ LEGACY COMPILED')
  const convertible = frameId !== undefined && !!sceneId
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
          {convertible ? (
            <>
              <ConvertSceneButton frameId={frameId} sceneId={sceneId} />
              Ports the scene's Nim to JavaScript in place. Nothing is saved until you do — check the result, then save
              or deploy. Or convert it by hand at{' '}
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
        {chipLabel}
      </Tag>
    </Tooltip>
  )
}
