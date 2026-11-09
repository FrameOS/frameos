import { Cog6ToothIcon } from '@heroicons/react/24/outline'
import { useActions, useValues } from 'kea'

import { Button } from '../../../../../components/Button'
import { H6 } from '../../../../../components/H6'
import { LAYOUT_STARTERS } from '../../../../../generated/layoutStarters'
import type { FrameId, FrameScene } from '../../../../../types'
import { SceneLayoutPicker } from '../../Scenes/SceneLayoutPicker'
import { SceneLayoutSettingsModal } from '../../Scenes/SceneLayoutSettingsModal'
import { sceneLayoutLogic } from '../../Scenes/sceneLayoutLogic'
import { useFrameSettings } from '../frameSettingsContext'
import { frameLayoutsLogic } from '../frameLayoutsLogic'

const DIFFERENT = '__different'

/** The settings of the layout a scene wears, beside its select; a layout with none has no button. */
function LayoutSettingsButton({
  frameId,
  sceneId,
  everyScene = false,
  label,
}: {
  frameId: FrameId
  sceneId: string
  everyScene?: boolean
  label: string
}): JSX.Element {
  const logic = sceneLayoutLogic({ frameId, sceneId })
  const { fields, currentLayoutScene, settingsOpen, settingsForEveryScene } = useValues(logic)
  const { openLayoutSettings } = useActions(logic)
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center">
      {currentLayoutScene && fields.length > 0 ? (
        <button
          type="button"
          title={label}
          aria-label={label}
          onClick={() => openLayoutSettings(everyScene)}
          className="frameos-secondary-button rounded p-1.5"
        >
          <Cog6ToothIcon className="h-4 w-4" />
        </button>
      ) : null}
      {settingsOpen && settingsForEveryScene === everyScene ? (
        <SceneLayoutSettingsModal frameId={frameId} sceneId={sceneId} />
      ) : null}
    </span>
  )
}

/** Which layout each scene on the frame wears and its settings, and one select for all of them. */
export function FrameLayoutsFields({ frameId }: { frameId: FrameId }): JSX.Element {
  const logic = frameLayoutsLogic({ frameId })
  const { layouts, contentScenes, commonLayoutId } = useValues(logic)
  const { chooseLayoutForEveryScene, addStarterLayout } = useActions(logic)
  return (
    <>
      <H6 id="frame-settings-layouts" className="mt-4">
        Layouts
      </H6>
      <div className="pl-2 @md:pl-8 space-y-2">
        {layouts.length === 0 ? (
          <div className="frameos-muted text-xs">
            This frame has no layouts yet. Add one below to get started, or turn on &quot;Use as layout&quot; for a JSX
            scene that has a &lt;yield /&gt;.
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
                {commonLayoutId ? (
                  <LayoutSettingsButton
                    frameId={frameId}
                    sceneId={contentScenes[0].id}
                    everyScene
                    label="Layout settings for all scenes"
                  />
                ) : (
                  <span className="h-8 w-8 shrink-0" />
                )}
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
                <LayoutSettingsButton
                  frameId={frameId}
                  sceneId={scene.id}
                  label={`Layout settings for ${scene.name || 'Untitled scene'}`}
                />
              </div>
            ))}
          </>
        )}
        <div className="flex flex-wrap items-center gap-2" data-layout-starters>
          <span className="frameos-muted text-xs">Add a layout:</span>
          {LAYOUT_STARTERS.map((starter) => (
            <Button
              key={starter.name}
              size="tiny"
              color="secondary"
              title={starter.description}
              onClick={() => addStarterLayout(starter.name)}
            >
              {starter.name}
            </Button>
          ))}
        </div>
      </div>
    </>
  )
}

export function LayoutsSection(): JSX.Element {
  const { frameId } = useFrameSettings()
  return <FrameLayoutsFields frameId={frameId} />
}
