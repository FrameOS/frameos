import { useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { sceneSettingsLogic } from './sceneSettingsLogic'
import { Form, Group } from 'kea-forms'
import { Field } from '../../../../components/Field'
import { NumberTextInput } from '../../../../components/NumberTextInput'
import { Button } from '../../../../components/Button'
import { ColorInput } from '../../../../components/ColorInput'
import { Select } from '../../../../components/Select'
import { TextArea } from '../../../../components/TextArea'

export interface SceneSettingsProps {
  sceneId: string
  onClose?: () => void
}

const sceneSettingsFieldClass = 'scene-settings-field frame-tool-row rounded-xl p-3 @md:items-center @md:gap-4'
const sceneSettingsPromptFieldClass = 'scene-settings-field frame-tool-row rounded-xl p-3 @md:items-start @md:gap-4'

function SceneSettingsLabel({ children }: { children: string }): JSX.Element {
  return <span className="frame-tool-control-label text-xs font-semibold uppercase tracking-wide">{children}</span>
}

export function SceneSettings({ sceneId, onClose }: SceneSettingsProps): JSX.Element {
  const { frameId, frameForm } = useValues(frameLogic)
  const { sceneIndex, scene } = useValues(sceneSettingsLogic({ frameId, sceneId }))
  if (!scene || !sceneId) {
    return <></>
  }

  return (
    <Form logic={frameLogic} props={{ frameId }} formKey="frameForm" className="scene-settings-form frame-tool-panel">
      <Group name={['scenes', sceneIndex]}>
        <div className="w-full space-y-3 @container">
          <Group name={['settings']}>
            <Field
              className={sceneSettingsFieldClass}
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
              className={sceneSettingsFieldClass}
              name="backgroundColor"
              label={<SceneSettingsLabel>Background color</SceneSettingsLabel>}
            >
              <ColorInput name="backgroundColor" className="!h-10 !min-w-0 @md:max-w-[12rem]" placeholder="#ffffff" />
            </Field>
            <Field
              className={sceneSettingsFieldClass}
              name="execution"
              label={<SceneSettingsLabel>Execution</SceneSettingsLabel>}
              tooltip={
                <div className="space-y-2">
                  <p>Choose between compiled and interpreted execution modes.</p>
                  <p>
                    <strong>Compiled</strong> scenes are optimized for performance. They require a full redeploy
                    whenever changes are made. If you edit the nim code for apps on the scene, you must use this mode.
                    All inline code nodes must also be written in Nim.
                  </p>
                  <p>
                    <strong>Interpreted</strong> scenes are executed as-is, allowing for fast deploys without the need
                    for recompilation. This mode is slower, but when your frame takes 20 seconds to render, it doesn't
                    matter much. Inline code nodes can use JavaScript, TypeScript, or JSX. You can't edit the nim
                    source of apps in this mode.
                  </p>
                  <p>A full deploy is needed if switching between modes.</p>
                </div>
              }
            >
              <Select
                name="execution"
                className="h-10"
                options={[
                  { value: 'compiled', label: 'compiled' },
                  { value: 'interpreted', label: 'interpreted' },
                ]}
              />
            </Field>
            {scene.settings?.prompt ? (
              <div className={`space-y-1 @md:flex ${sceneSettingsPromptFieldClass}`}>
                <label className="frameos-form-label flex items-center gap-1 text-sm font-medium @md:w-1/3">
                  <SceneSettingsLabel>Prompt</SceneSettingsLabel>
                </label>
                <div className="w-full">
                  <TextArea readOnly value={scene.settings.prompt} rows={4} />
                </div>
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

SceneSettings.PanelTitle = function SceneSettingsPanelTitle() {
  return <>Scene Settings</>
}
