import { useActions, useValues } from 'kea'

import { H6 } from '../../../../../components/H6'
import type { FrameId, FrameScene } from '../../../../../types'
import { SceneLayoutPicker } from '../../Scenes/SceneLayoutPicker'
import { useFrameSettings } from '../frameSettingsContext'
import { frameLayoutsLogic } from '../frameLayoutsLogic'

const DIFFERENT = '__different'

/** Which layout each scene on the frame wears, and one select for all of them. */
export function FrameLayoutsFields({ frameId }: { frameId: FrameId }): JSX.Element {
  const logic = frameLayoutsLogic({ frameId })
  const { layouts, contentScenes, commonLayoutId } = useValues(logic)
  const { chooseLayoutForEveryScene } = useActions(logic)
  return (
    <>
      <H6 id="frame-settings-layouts" className="mt-4">
        Layouts
      </H6>
      <div className="pl-2 @md:pl-8 space-y-2">
        {layouts.length === 0 ? (
          <div className="frameos-muted text-xs">
            This frame has no layouts yet. Add one with &quot;New layout&quot; under Add scene, or turn on &quot;Use as
            layout&quot; in a scene&apos;s settings.
          </div>
        ) : (
          <>
            <div className="frameos-muted text-xs">
              The layout each scene is drawn inside. Save the frame to push the change.
            </div>
            {contentScenes.length > 1 ? (
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">All scenes</span>
                <select
                  aria-label="Layout for all scenes"
                  value={commonLayoutId ?? DIFFERENT}
                  onChange={(event) => chooseLayoutForEveryScene(event.target.value)}
                  className="frameos-form-control h-8 w-full max-w-[14rem] min-w-0 truncate rounded border px-1 text-sm outline-none focus:ring-1 focus:ring-blue-400"
                >
                  {commonLayoutId === null ? (
                    <option value={DIFFERENT} disabled>
                      Different layouts
                    </option>
                  ) : null}
                  <option value="">No layout</option>
                  {(layouts as FrameScene[]).map((layout) => (
                    <option key={layout.id} value={layout.id}>
                      {layout.name || 'Untitled layout'}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {(contentScenes as FrameScene[]).map((scene) => (
              <div key={scene.id} className="flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate text-sm">{scene.name || 'Untitled scene'}</span>
                <SceneLayoutPicker
                  frameId={frameId}
                  sceneId={scene.id}
                  ariaLabel={`Layout for ${scene.name || 'Untitled scene'}`}
                  className="!h-8 max-w-[14rem] !text-sm !font-normal"
                />
              </div>
            ))}
          </>
        )}
      </div>
    </>
  )
}

export function LayoutsSection(): JSX.Element {
  const { frameId } = useFrameSettings()
  return <FrameLayoutsFields frameId={frameId} />
}
