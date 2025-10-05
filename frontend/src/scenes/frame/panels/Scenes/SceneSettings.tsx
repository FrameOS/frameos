import { useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { sceneSettingsLogic } from './sceneSettingsLogic'
import { Form, Group } from 'kea-forms'
import { Field } from '../../../../components/Field'
import { NumberTextInput } from '../../../../components/NumberTextInput'
import { Button } from '../../../../components/Button'
import { ColorInput } from '../../../../components/ColorInput'
import { Select } from '../../../../components/Select'

export interface SceneSettingsProps {
  sceneId: string
  onClose?: () => void
}

export function SceneSettings({ sceneId, onClose }: SceneSettingsProps): JSX.Element {
  const { frameId, frameForm } = useValues(frameLogic)
  const { sceneIndex, scene } = useValues(sceneSettingsLogic({ frameId, sceneId }))
  if (!scene || !sceneId) {
    return <></>
  }

  return (
    <Form logic={frameLogic} props={{ frameId }} formKey="frameForm">
      <Group name={['scenes', sceneIndex]}>
        <div className="w-full space-y-1">
          <Group name={['settings']}>
            <Field
              className="flex flex-row gap-2 w-full justify-between"
              name="refreshInterval"
              label="Refresh interval in seconds"
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
                style={{ width: 70 }}
              />
            </Field>
            <Field
              className="flex flex-row gap-2 w-full justify-between"
              name="backgroundColor"
              label="Background color"
            >
              <ColorInput name="backgroundColor" className="!p-0" style={{ width: 70 }} placeholder="#ffffff" />
            </Field>
            <Field
              className="flex flex-row gap-2 w-full justify-between"
              name="execution"
              label="Execution"
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
                    matter much. You must use JavaScript in inline code nodes. You can't edit the nim source of apps in
                    this mode.
                  </p>
                  <p>A full deploy is needed if switching between modes.</p>
                </div>
              }
            >
              <Select
                name="execution"
                className="border rounded px-1 py-0.5"
                options={[
                  { value: 'compiled', label: 'compiled' },
                  { value: 'interpreted', label: 'interpreted' },
                ]}
              />
            </Field>
          </Group>
          {onClose ? (
            <Button size="small" onClick={onClose}>
              Close
            </Button>
          ) : null}
        </div>
      </Group>
    </Form>
  )
}

SceneSettings.PanelTitle = function SceneSettingsPanelTitle() {
  return <>Scene Settings</>
}
