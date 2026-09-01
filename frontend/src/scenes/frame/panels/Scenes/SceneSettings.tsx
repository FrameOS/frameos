import { useActions, useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { sceneSettingsLogic } from './sceneSettingsLogic'
import { Form, Group } from 'kea-forms'
import { Field } from '../../../../components/Field'
import { NumberTextInput } from '../../../../components/NumberTextInput'
import { Button } from '../../../../components/Button'
import { ColorInput } from '../../../../components/ColorInput'
import { Select } from '../../../../components/Select'
import { TextArea } from '../../../../components/TextArea'
import { AdvancedSection } from '../../../../components/AdvancedSection'
import { sceneRequiresCompilation } from '../../../../utils/sceneApps'
import { frameRunsScenesInterpreted, sceneExecutionForFrame } from '../../../../utils/sceneExecution'

export interface SceneSettingsProps {
  sceneId: string
  onClose?: () => void
  embedded?: boolean
}

const sceneSettingsFieldClass = 'scene-settings-field frame-tool-row rounded-xl p-3 @md:items-center @md:gap-4'
const sceneSettingsEmbeddedFieldClass = 'scene-settings-field @md:items-center @md:gap-4'

function SceneSettingsLabel({ children }: { children: string }): JSX.Element {
  return <span className="frame-tool-control-label text-xs font-semibold uppercase tracking-wide">{children}</span>
}

export function SceneSettings({ sceneId, onClose, embedded = false }: SceneSettingsProps): JSX.Element {
  const { frameId, frameForm, convertingSceneId } = useValues(frameLogic)
  const { convertSceneToInterpreted } = useActions(frameLogic)
  const { sceneIndex, scene } = useValues(sceneSettingsLogic({ frameId, sceneId }))
  if (!scene || !sceneId) {
    return <></>
  }
  const fieldClassName = embedded ? sceneSettingsEmbeddedFieldClass : sceneSettingsFieldClass
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
          <Group name={['settings']}>
            <Field
              className={fieldClassName}
              name="refreshInterval"
              label={<SceneSettingsLabel>Refresh interval</SceneSettingsLabel>}
              tooltip={
                <>
                  How often do we trigger a refresh, in seconds. Pass a large number like "60" or even more for e-ink
                  frames. A number below 1 activates realtime mode (0.041s = 24fps, 0.016s = 60fps). This should be used
                  when you're certain of your setup and only if your hardware supports it.
                </>
              }
            >
              <NumberTextInput
                name="refreshInterval"
                placeholder={String(frameForm.interval || 300)}
                className="h-10 @md:max-w-[9rem]"
              />
            </Field>
            <Field
              className={fieldClassName}
              name="backgroundColor"
              label={<SceneSettingsLabel>Background color</SceneSettingsLabel>}
            >
              <ColorInput name="backgroundColor" className="!h-10 !min-w-0" placeholder="#ffffff" />
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
