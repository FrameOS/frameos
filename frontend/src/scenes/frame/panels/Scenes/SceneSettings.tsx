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
import { TextInput } from '../../../../components/TextInput'
import { AdvancedSection } from '../../../../components/AdvancedSection'
import { Tooltip } from '../../../../components/Tooltip'
import { SceneAccessTags } from './SceneAccessTags'
import { Switch } from '../../../../components/Switch'
import { SceneLayoutPicker } from './SceneLayoutPicker'
import { sceneLayoutLogic } from './sceneLayoutLogic'
import type { FrameId } from '../../../../types'
import clsx from 'clsx'
import { sceneRequiresCompilation } from '../../../../utils/sceneApps'
import { frameRunsScenesInterpreted, sceneExecutionForFrame } from '../../../../utils/sceneExecution'
import {
  DEFAULT_REFRESH_INTERVAL_SECONDS,
  REFRESH_INTERVAL_FIELD_NAME,
  refreshIntervalFieldIndex,
} from '../../../../utils/refreshInterval'
import {
  SCENE_RENDER_SCALE_HELP,
  sceneRenderScaleFromSelect,
  sceneRenderScaleSelectValue,
} from '../../../../utils/renderScale'
import { sceneRoundChoice, sceneRoundFromChoice } from '../../../../utils/sceneNeeds'
import {
  SCENE_WINDOW_SIZE_HELP,
  sceneWindowSizeFromSelect,
  sceneWindowSizeSelectValue,
} from '../../../../utils/sceneWindowSize'
import { SCENE_ICON_HELP, sceneIconFromInput } from '../../../../utils/sceneIcon'
import { SCENE_CATEGORY_HELP, sceneCategoryFromSelect } from '../../../../utils/sceneCategory'
import { SceneIcon } from '../../../../components/SceneIcon'

function SceneLayoutField({ frameId, sceneId }: { frameId: FrameId; sceneId: string }): JSX.Element | null {
  const { pickerVisible } = useValues(sceneLayoutLogic({ frameId, sceneId }))
  if (!pickerVisible) {
    return null
  }
  return (
    <div className="flex items-center justify-between gap-4">
      <SceneSettingsLabel>Layout</SceneSettingsLabel>
      <SceneLayoutPicker frameId={frameId} sceneId={sceneId} className="!h-10 @md:max-w-[12rem]" />
    </div>
  )
}

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

// `settings.opens`, docs/scene-guide.md "Opening files": listed as it is on app.frame.scenes.
const opensTooltip =
  'The kinds of file this scene opens, by their extension: "pdf", or "txt md json" for several. The Files app ' +
  'opens such a file in this scene, which gets it in its public field "file".'

function SceneSettingsLabel({ children }: { children: string }): JSX.Element {
  return <span className="frame-tool-control-label text-xs font-semibold uppercase tracking-wide">{children}</span>
}

export function SceneSettings({ sceneId, onClose, embedded = false }: SceneSettingsProps): JSX.Element {
  const { frameId, frameForm, convertingSceneId } = useValues(frameLogic)
  const { convertSceneToInterpreted } = useActions(frameLogic)
  const { uploadIcon, setIcon } = useActions(sceneSettingsLogic({ frameId, sceneId }))
  const {
    sceneIndex,
    scene,
    permissionRows,
    permissionApps,
    splitRhythm,
    pacedByInterval,
    renderScaleOptions,
    renderScaleFieldName,
    layoutProblem,
    windowSizeOptions,
    iconPath,
    iconProblem,
    iconUploadError,
    categoryOptions,
    roundOptions,
  } = useValues(sceneSettingsLogic({ frameId, sceneId }))
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
                    placeholder={String(scene.settings?.refreshInterval || DEFAULT_REFRESH_INTERVAL_SECONDS)}
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
                    pacedByInterval ? (
                      <>
                        The fastest this split renders on this display. Each panel renders when its own scene is due,
                        and the others keep their picture until their time comes; the split waits longer when no panel
                        is due. Set a panel's own interval in its options. Rendering the frame by hand redraws every
                        panel.
                      </>
                    ) : (
                      <>
                        On this display the split renders whenever one of its panels is due, so this number holds it
                        back from nothing. The others keep their picture until their time comes. Set a panel's own
                        interval in its options. Rendering the frame by hand redraws every panel.
                      </>
                    )
                  ) : (
                    <>
                      {refreshIntervalTooltip} Scene code reads it as <code>state.{REFRESH_INTERVAL_FIELD_NAME}</code>.
                    </>
                  )
                }
              >
                <RefreshIntervalInput
                  name="refreshInterval"
                  placeholder={String(DEFAULT_REFRESH_INTERVAL_SECONDS)}
                  className="h-10 @md:max-w-[9rem]"
                />
              </Field>
            </Group>
          )}
          <div className={clsx(fieldClassName, 'space-y-1')} data-scene-settings-layout>
            <SceneLayoutField frameId={frameId} sceneId={sceneId} />
          </div>
          <Group name={['settings']}>
            <Field
              className={fieldClassName}
              name="isLayout"
              label={<SceneSettingsLabel>Use as layout</SceneSettingsLabel>}
              hint={layoutProblem ?? undefined}
              tooltip="A layout wraps other scenes (a clock bar above them, say). It leaves the scene lists and goes under Layouts, and any scene on this frame can then wear it."
            >
              <Switch name="isLayout" disabled={!!layoutProblem && !scene.settings?.isLayout} />
            </Field>
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
            {scene.settings?.isLayout ? null : (
              <Field
                className={fieldClassName}
                name="windowSize"
                label={<SceneSettingsLabel>Window size</SceneSettingsLabel>}
                tooltip={SCENE_WINDOW_SIZE_HELP}
              >
                {({ value, onChange }) => (
                  <Select
                    name="windowSize"
                    className="h-10"
                    value={sceneWindowSizeSelectValue(value)}
                    onChange={(next) => onChange(sceneWindowSizeFromSelect(next))}
                    options={windowSizeOptions}
                  />
                )}
              </Field>
            )}
            {scene.settings?.isLayout ? null : (
              <Field
                className={fieldClassName}
                name="round"
                label={<SceneSettingsLabel>Round screens</SceneSettingsLabel>}
                tooltip="Whether the scene works on a round screen (only the circle inside the panel shows). The store marks it Round screen and offers it first to round frames. Automatic: it does when its code asks context.round or app.frame.round. Square and rectangular screens see no difference."
              >
                {({ value, onChange }) => (
                  <Select
                    name="round"
                    className="h-10"
                    value={sceneRoundChoice(value)}
                    onChange={(next) => onChange(sceneRoundFromChoice(next))}
                    options={roundOptions}
                  />
                )}
              </Field>
            )}
            {scene.settings?.isLayout ? null : (
              <Field
                className={fieldClassName}
                name="fullScreen"
                label={<SceneSettingsLabel>Full screen</SceneSettingsLabel>}
                tooltip="Ask the frame's layout for the whole panel: no bar or dock around this scene, as a book or a photo wants. A field of the scene used as full screen wins over this, so people can choose on the frame."
              >
                <Switch name="fullScreen" />
              </Field>
            )}
            <Field
              className={fieldClassName}
              name="category"
              label={<SceneSettingsLabel>Category</SceneSettingsLabel>}
              tooltip={SCENE_CATEGORY_HELP}
            >
              {({ value, onChange }) => (
                <Select
                  name="category"
                  className="h-10"
                  value={typeof value === 'string' ? value : ''}
                  onChange={(next) => onChange(sceneCategoryFromSelect(next))}
                  options={categoryOptions}
                />
              )}
            </Field>
            {scene.settings?.isLayout ? null : (
              <Field
                className={fieldClassName}
                name="opens"
                label={<SceneSettingsLabel>Opens files</SceneSettingsLabel>}
                tooltip={opensTooltip}
              >
                {({ value, onChange }) => (
                  <TextInput
                    name="opens"
                    className="!h-10"
                    placeholder="pdf epub"
                    value={typeof value === 'string' ? value : ''}
                    onChange={(next) => onChange(next || undefined)}
                  />
                )}
              </Field>
            )}
            <Field
              className={fieldClassName}
              name="icon"
              label={<SceneSettingsLabel>Icon</SceneSettingsLabel>}
              tooltip={SCENE_ICON_HELP}
              hint={
                iconUploadError || iconProblem ? (
                  <span className="text-amber-500" data-scene-icon-problem>
                    {iconUploadError ?? iconProblem}
                  </span>
                ) : undefined
              }
            >
              {({ value, onChange }) => (
                <div className="space-y-2" data-scene-icon>
                  <div className="flex items-center gap-3">
                    {/* As small as a list draws it, and larger to check the details. */}
                    <div className="frameos-muted flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-500/20">
                      {iconPath ? <SceneIcon path={iconPath} className="h-6 w-6" /> : null}
                    </div>
                    <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border border-slate-500/20">
                      {iconPath ? <SceneIcon path={iconPath} className="h-14 w-14" /> : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <label className="frameos-button frameos-secondary-button cursor-pointer rounded-md px-2 py-1 text-sm font-medium">
                        Upload SVG
                        <input
                          type="file"
                          accept=".svg,image/svg+xml"
                          className="hidden"
                          onChange={(event) => {
                            const file = event.target.files?.[0]
                            event.target.value = ''
                            if (file) {
                              uploadIcon(file)
                            }
                          }}
                        />
                      </label>
                      <Button size="small" color="secondary" disabled={!value} onClick={() => setIcon(null)}>
                        Clear
                      </Button>
                    </div>
                  </div>
                  <TextArea
                    name="icon"
                    rows={2}
                    className="font-mono text-xs"
                    placeholder="One SVG path in a 24 × 24 box, like M12 2L2 22h20z"
                    spellCheck={false}
                    value={typeof value === 'string' ? value : ''}
                    onChange={(text) => onChange(sceneIconFromInput(text))}
                  />
                </div>
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
