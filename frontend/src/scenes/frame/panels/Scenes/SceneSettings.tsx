import { useActions, useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { sceneSettingsLogic } from './sceneSettingsLogic'
import { Form, Group } from 'kea-forms'
import { Field } from '../../../../components/Field'
import { RefreshIntervalInput } from '../../../../components/RefreshIntervalInput'
import { Button } from '../../../../components/Button'
import { ColorInput } from '../../../../components/ColorInput'
import { Select } from '../../../../components/Select'
import { TextArea } from '../../../../components/TextArea'
import { AdvancedSection } from '../../../../components/AdvancedSection'
import { Tooltip } from '../../../../components/Tooltip'
import { SceneAccessTags } from './SceneAccessTags'
import clsx from 'clsx'
import { sceneRequiresCompilation } from '../../../../utils/sceneApps'
import { frameRunsScenesInterpreted, sceneExecutionForFrame } from '../../../../utils/sceneExecution'
import { REFRESH_INTERVAL_FIELD_NAME, refreshIntervalFieldIndex } from '../../../../utils/refreshInterval'
import {
  SCENE_RENDER_SCALE_HELP,
  sceneRenderScaleFromSelect,
  sceneRenderScaleSelectValue,
} from '../../../../utils/renderScale'

export interface SceneSettingsProps {
  sceneId: string
  onClose?: () => void
  embedded?: boolean
}

const sceneSettingsFieldClass = 'scene-settings-field frame-tool-row rounded-xl p-3 @md:items-center @md:gap-4'
const sceneSettingsEmbeddedFieldClass = 'scene-settings-field @md:items-center @md:gap-4'

const refreshIntervalTooltip =
  "The default number of seconds between renders. Anyone controlling the scene can change it from the scene's " +
  'options. Use a large number like "60" or more for e-ink frames. A number below 1 ' +
  'activates realtime mode (0.041s = 24fps, 0.016s = 60fps): only if your hardware supports it.'

function SceneSettingsLabel({ children }: { children: string }): JSX.Element {
  return <span className="frame-tool-control-label text-xs font-semibold uppercase tracking-wide">{children}</span>
}

export function SceneSettings({ sceneId, onClose, embedded = false }: SceneSettingsProps): JSX.Element {
  const { frameId, frameForm, convertingSceneId } = useValues(frameLogic)
  const { convertSceneToInterpreted } = useActions(frameLogic)
  const { sceneIndex, scene, permissionRows, permissionApps, splitRhythm, renderScaleOptions, renderScaleFieldName } =
    useValues(sceneSettingsLogic({ frameId, sceneId }))
  if (!scene || !sceneId) {
    return <></>
  }
  const fieldClassName = embedded ? sceneSettingsEmbeddedFieldClass : sceneSettingsFieldClass
  const refreshFieldIndex = refreshIntervalFieldIndex(scene.fields)
  const refreshFieldName = refreshFieldIndex >= 0 ? scene.fields?.[refreshFieldIndex]?.name : undefined
  const frameRunsInterpreted = frameRunsScenesInterpreted(frameForm.mode)
  const execution = sceneExecutionForFrame(scene, frameForm.mode)
  const hasCompiledOnlyContent = sceneRequiresCompilation(scene)
  const hasInterpretedCompiledOnlyContent = execution === 'interpreted' && hasCompiledOnlyContent

  return (
    <Form
      logic={frameLogic}
      props={{ frameId }}
      formKey="frameForm"
      className={embedded ? 'scene-settings-form' : 'scene-settings-form frame-tool-panel'}
    >
      <Group name={['scenes', sceneIndex]}>
        <div className="w-full space-y-3 @container">
          {refreshFieldIndex >= 0 ? (
            // The scene declares its own interval field (by role or by name):
            // that field's default IS the scene's default.
            <Group name={['fields', refreshFieldIndex]}>
              <Field
                className={fieldClassName}
                name="value"
                label={<SceneSettingsLabel>Refresh interval</SceneSettingsLabel>}
                tooltip={
                  <>
                    {refreshIntervalTooltip} This scene keeps it in its own state field,{' '}
                    <code>state.{refreshFieldName}</code>; this is that field's default.
                  </>
                }
              >
                {({ value, onChange }) => (
                  <RefreshIntervalInput
                    value={value}
                    onChange={(seconds) => onChange(seconds === undefined ? '' : String(seconds))}
                    placeholder={String(scene.settings?.refreshInterval || frameForm.interval || 300)}
                    className="h-10 @md:max-w-[9rem]"
                  />
                )}
              </Field>
            </Group>
          ) : (
            <Group name={['settings']}>
              <Field
                className={fieldClassName}
                name="refreshInterval"
                label={<SceneSettingsLabel>Refresh interval</SceneSettingsLabel>}
                hint={splitRhythm ?? undefined}
                tooltip={
                  splitRhythm !== null ? (
                    <>
                      The fastest this split renders. Each panel renders when its own scene is due, and the others keep
                      their picture until their time comes; the split waits longer when no panel is due. Set a panel's
                      own interval in its options. Rendering the frame by hand redraws every panel.
                    </>
                  ) : (
                    <>
                      {refreshIntervalTooltip} Scene code reads it as <code>state.{REFRESH_INTERVAL_FIELD_NAME}</code>.
                    </>
                  )
                }
              >
                <RefreshIntervalInput
                  name="refreshInterval"
                  placeholder={String(frameForm.interval || 300)}
                  className="h-10 @md:max-w-[9rem]"
                />
              </Field>
            </Group>
          )}
          <Group name={['settings']}>
            <Field
              className={fieldClassName}
              name="backgroundColor"
              label={<SceneSettingsLabel>Background color</SceneSettingsLabel>}
            >
              <ColorInput name="backgroundColor" className="!h-10 !min-w-0" placeholder="#ffffff" />
            </Field>
            <Field
              className={fieldClassName}
              name="renderScale"
              label={<SceneSettingsLabel>Scale</SceneSettingsLabel>}
              tooltip={
                renderScaleFieldName ? (
                  <>
                    {SCENE_RENDER_SCALE_HELP} This scene also keeps a scale in its own state field,{' '}
                    <code>state.{renderScaleFieldName}</code>, which wins over this one when it holds a value.
                  </>
                ) : (
                  SCENE_RENDER_SCALE_HELP
                )
              }
            >
              {({ value, onChange }) => (
                <Select
                  name="renderScale"
                  className="h-10"
                  value={sceneRenderScaleSelectValue(value)}
                  onChange={(next) => onChange(sceneRenderScaleFromSelect(next))}
                  options={renderScaleOptions}
                />
              )}
            </Field>
            {frameRunsInterpreted ? null : (
              <AdvancedSection className={fieldClassName}>
                <Field
                  className={fieldClassName}
                  name="execution"
                  label={<SceneSettingsLabel>Execution</SceneSettingsLabel>}
                  tooltip={
                    <div className="space-y-2">
                      <p>
                        <strong>Interpreted</strong> is how scenes run: JavaScript code nodes and apps, fast deploys
                        from the released FrameOS binaries, live preview in the browser.
                      </p>
                      <p>
                        <strong>Compiled</strong> is the legacy mode for scenes that still carry Nim code nodes or Nim
                        app sources. It needs a full FrameOS source build on every deploy. Convert it to an interpreted
                        scene instead (scenes.frameos.net/nim-converter).
                      </p>
                    </div>
                  }
                >
                  <Select
                    name="execution"
                    className="h-10"
                    options={[
                      { value: 'interpreted', label: 'Interpreted' },
                      { value: 'compiled', label: 'Compiled (legacy — needs a source build on every deploy)' },
                    ]}
                  />
                </Field>
              </AdvancedSection>
            )}
            {hasCompiledOnlyContent || execution === 'compiled' ? (
              <div className="app-compiled-warning rounded-xl p-3 text-sm space-y-2">
                <div className="font-semibold">
                  {frameRunsInterpreted
                    ? 'This scene carries Nim that ESP32 frames cannot run.'
                    : hasInterpretedCompiledOnlyContent
                    ? 'This scene carries Nim that interpreted mode will not run.'
                    : 'Legacy compiled scene — needs a FrameOS source build on every deploy.'}
                </div>
                <div>
                  {hasCompiledOnlyContent
                    ? 'It still contains Nim app sources, Nim code nodes, or source nodes. Convert it to an interpreted scene: the converter ports the code nodes and apps to JavaScript, and the scene deploys from the released binaries.'
                    : 'Nothing in it needs the compiler any more — switch execution to Interpreted.'}
                </div>
                {hasCompiledOnlyContent ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="small"
                      color="primary"
                      disabled={convertingSceneId === sceneId}
                      onClick={() => convertSceneToInterpreted(sceneId)}
                    >
                      {convertingSceneId === sceneId ? 'Converting…' : 'Convert to an interpreted scene'}
                    </Button>
                    <span className="frameos-muted text-xs">
                      Converts in place, unsaved — check the result, then save or deploy.
                    </span>
                  </div>
                ) : null}
              </div>
            ) : null}
          </Group>
          <div className={clsx(fieldClassName, 'space-y-2')}>
            <div className="flex items-center gap-1">
              <SceneSettingsLabel>Permissions</SceneSettingsLabel>
              <Tooltip
                title={
                  <div className="space-y-2">
                    <p>
                      What this scene's apps may do on the frame. Each app asks in its config.json under "permissions",
                      and the frame gives it exactly that list.
                    </p>
                    <p>A JavaScript app's list is set from its code every time the scene is saved.</p>
                    <p>Frames before FrameOS 2026.10.16 ignore the lists.</p>
                  </div>
                }
              />
            </div>
            {permissionRows.length === 0 ? (
              <div className="frameos-muted text-xs">This scene's apps ask for nothing.</div>
            ) : (
              <ul className="space-y-1">
                {permissionRows.map((row) => (
                  <li key={row.flag} className="flex flex-wrap items-center gap-2 text-xs">
                    <SceneAccessTags flags={[row.flag]} />
                    <span className="frameos-muted">asked by {row.askedBy.join(', ')}</span>
                  </li>
                ))}
              </ul>
            )}
            {permissionApps.length > 0 ? (
              <ul className="frameos-muted space-y-1 text-xs">
                {permissionApps.map((app) => (
                  <li key={app.name}>
                    {app.name}: {app.source}
                    {app.warning ? <div className="app-compiled-warning mt-1 rounded p-1.5">{app.warning}</div> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          {onClose ? (
            <div className="flex justify-end">
              <Button size="small" onClick={onClose}>
                Close
              </Button>
            </div>
          ) : null}
        </div>
      </Group>
    </Form>
  )
}
